/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { applyChange, createQuote, type ReviewCard } from "@/lib/gate/changes";
import { GateError } from "@/lib/gate/errors";
import { getLatestPack } from "@/lib/packs/build";
import type { OfflinePack } from "@/lib/packs/types";
import { currentStay } from "@/lib/rules/context";
import { openCase, maskPhone } from "@/lib/server/cases";
import { searchFlights } from "@/app/api/mock/v1/flights/search/route";
import { stayAvailability } from "@/app/api/mock/v1/stays/availability/route";
import { getSmsAdapter } from "@/lib/sms/adapter";
import { flightProviders, MOCK_SOURCE } from "@/lib/providers";
import { searchWeb } from "@/lib/providers/web";
import { refreshOfflinePack } from "@/lib/packs/refresh";
import { connectedPlatforms } from "@/lib/server/connections";
import { platformLinks, PLATFORMS } from "@/lib/providers/platforms";
import { compareFlightsOrSample } from "@/lib/providers/compare";
import { compareHotelsOrSample, type HotelOffer } from "@/lib/providers/hotels";
import type { PlatformPrice } from "@/lib/providers/partners";
import { hotelLinks } from "@/lib/providers/platforms";
import { addDays, fmtDate, inr, localDate, localTime, tzLabel, zonedToUtc } from "@/lib/time";
import { rateSeverity, SLA_SECONDS, type Severity } from "../severity";

export type UiEvent =
  | DetailsUi
  | { t: "review"; card: ReviewCard }
  | { t: "case"; caseRef: string; severity: number; slaSeconds: number; summary: string }
  | { t: "route"; routeId: string; fromName: string; toName: string; distance_m: number; duration_s: number; approximate: boolean; url: string }
  | { t: "receipt"; receipt: unknown }
  | { t: "compare"; bookingRef: string; itemId: string; query: { from: string; to: string; date: string; pax: number }; flight: { flightNo: string; carrier: string; from: string; to: string; date: string; departsLocal: string; arrivesLocal: string; departIso: string; arriveIso: string; pnr: string; leg: string; pax: number }; sample?: boolean; providers: { name: string; ok: boolean; count: number; error?: string }[]; offers: { id: string; providerLabel: string; source: string; totalInr: number; perTravellerInr: number; breakup: { label: string; amountInr: number }[]; facts: { carrier: string; flightNo: string; from: string; to: string; departLocal: string; arriveLocal: string; stops: number; durationMin?: number }; validUntil: string; platformPrices?: PlatformPrice[] }[]; cheapestId?: string; fastestId?: string; platforms: { id: string; name: string; searchUrl: string; manageUrl: string; connected: boolean }[] }
  | { t: "hotels"; bookingRef: string; itemId: string; configured: boolean; sample?: boolean; current: { name: string; city: string; address: string; checkin: string; checkout: string; rooms: number; lat: number; lon: number }; query: { checkin: string; checkout: string; nights: number; rooms: number; adults: number; city: string }; providers: { name: string; ok: boolean; count: number; error?: string }[]; offers: HotelOffer[]; cheapestId?: string; platforms: { id: string; name: string; hotelsUrl: string; connected: boolean }[] }
  | { t: "platforms"; bookingRef: string; itemId: string; flight: { flightNo: string; carrier: string; from: string; to: string; date: string; departsLocal: string; arrivesLocal: string; departIso: string; arriveIso: string; pnr: string; leg: string; pax: number }; platforms: { id: string; name: string; searchUrl: string; manageUrl: string; connected: boolean }[] };

export type DetailsPrefill = { airline?: string; flightNo?: string; from?: string; to?: string; departLocal?: string; arriveLocal?: string; pnr?: string; name?: string; address?: string; city?: string; checkin?: string; checkout?: string; phone?: string };
export type DetailsUi = { t: "details"; bookingRef: string; kind: "flight" | "hotel"; prefill: DetailsPrefill };

export type ToolCtx = {
  userId: string;
  bookingRef: string;
  bookingId: string;
  threadId: string | null;
  channel: "app" | "sms";
  now: Date;
  chaos?: string | null;
  /** Only ever set by the server when the traveller's client sends a token minted by their Confirm tap. Never given to the model. */
  confirmationToken?: string | null;
  ui: (e: UiEvent) => void;
};

export const TOOL_NAMES = ["get_itinerary", "get_route", "search_flights", "connect_platform", "compare_flights", "compare_hotels", "search_stays", "search_web", "add_trip_details", "quote_change", "apply_change", "refresh_offline_pack", "escalate_human", "send_sms"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** The model's allow-list. refresh_offline_pack is a server-side job that runs only after apply_change succeeds. */
/** search_flights (mock inventory) is not offered to the model: flight changes go through the traveller's own booking platform (connect_platform). */
export const MODEL_TOOLS: ToolName[] = TOOL_NAMES.filter((t) => t !== "refresh_offline_pack" && t !== "search_flights" && t !== "search_stays");

/** Tools that SMS-channel runs may use (read-only plus escalation). */
export const SMS_SAFE_TOOLS: ToolName[] = ["get_itinerary", "escalate_human", "send_sms"];

async function logged<T>(ctx: ToolCtx, name: ToolName, input: unknown, fn: () => Promise<T>): Promise<T | { error: string; message: string }> {
  const db = await getDb();
  const t0 = Date.now();
  try {
    const out = await fn();
    await db.insert(s.toolCalls).values({ threadId: ctx.threadId, bookingId: ctx.bookingId, tool: name, input: input as never, output: out as never, status: "ok", latencyMs: Date.now() - t0 });
    return out;
  } catch (e) {
    const err = e instanceof GateError ? { error: e.code, message: e.message } : { error: "TOOL_ERROR", message: e instanceof Error ? e.message : String(e) };
    await db.insert(s.toolCalls).values({ threadId: ctx.threadId, bookingId: ctx.bookingId, tool: name, input: input as never, output: err as never, status: e instanceof GateError && (e.code === "NO_TOKEN" || e.code === "OVER_LIMIT") ? "blocked" : "error", latencyMs: Date.now() - t0 });
    return err;
  }
}

async function loadPack(ctx: ToolCtx) {
  const db = await getDb();
  const row = await getLatestPack(ctx.bookingId, db);
  if (!row) throw new GateError("NOT_FOUND", 404, "No trip data found for this booking.");
  return row.pack as OfflinePack;
}

/* ---------------------------- tool implementations ---------------------------- */

export async function getItinerary(ctx: ToolCtx) {
  const db = await getDb();
  const pack = await loadPack(ctx);
  const stay = currentStay(pack, ctx.now);
  const localNow = `${localTime(ctx.now, stay.tz)} ${tzLabel(ctx.now, stay.tz)}`;
  const flat = pack.days.flatMap((d) => d.items.map((i) => ({ ...i, date: d.date, city: d.cityName, at: zonedToUtc(d.date, i.time, d.tz) })));
  const upcoming = flat.filter((i) => i.at.getTime() >= ctx.now.getTime() - 30 * 60_000).slice(0, 4);
  const status = ctx.now < new Date(`${pack.booking.dates[0]}T00:00:00Z`) ? "not started" : ctx.now > new Date(`${pack.booking.dates[1]}T23:59:00Z`) ? "finished" : "in progress";
  const flights = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, ctx.bookingId), eq(s.bookingItems.kind, "flight"), eq(s.bookingItems.status, "confirmed")));
  const hotel = pack.places[stay.hotelId];
  const pu = flat.find((i) => i.type === "transfer" && /^Pickup/.test(i.title) && i.date === stay.from);
  const show = (i: (typeof flat)[number]) => ({ date: fmtDate(i.date), time: i.time, what: i.title, notes: i.notes });
  return {
    bookingRef: pack.booking.ref, title: pack.booking.title, dates: pack.booking.dates, travellers: pack.booking.pax, tripStatus: status,
    today: localDate(ctx.now, stay.tz), travellerLocalTime: localNow, timezone: stay.tz, currentCity: stay.cityName,
    nextPlans: (upcoming.length ? upcoming : flat.slice(0, 4)).map(show),
    pickup: { date: pu ? fmtDate(pu.date) : undefined, time: pu?.time, when: stay.driver.pickup_time, driver: stay.driver.name, vendor: stay.driver.vendor, code: stay.driver.pickup_code, phoneSample: stay.driver.phone, to: hotel.name },
    hotel: { name: hotel.name, address: hotel.address, addressLocal: hotel.address_local, phoneSample: hotel.phone, checkIn: fmtDate(stay.from), checkOut: fmtDate(stay.to) },
    flights: flights
      .map((f) => ({ itemId: f.id, leg: f.details.leg, flightNo: f.details.flightNo, carrier: f.details.carrierName, from: f.details.from, to: f.details.to, departsUtc: f.details.departAt, arrivesUtc: f.details.arriveAt, farePerTravellerInr: f.details.farePerPaxInr, changeFeeInr: f.details.changeFeeInr, date: f.date }))
      .sort((a, b) => String(a.departsUtc).localeCompare(String(b.departsUtc))),
    missingDetails: { flights: flights.length === 0, hotel: hotel?.kind !== "hotel" },
    ...(hotel?.kind !== "hotel" ? { hotelNote: "No hotel has been added to this trip yet, so the hotel fields above are only the city centre. Offer add_trip_details with kind hotel." } : {}),
    totalInr: pack.booking.totalInr,
    note: "Sample data from the traveller's booking.",
  };
}

/** Shows a form (prefilled from what the traveller said) to add a missing flight or hotel. The traveller reviews it and taps Save; the model never saves anything. */
export async function addTripDetailsTool(ctx: ToolCtx, input: { kind: "flight" | "hotel"; prefill?: DetailsPrefill }) {
  const db = await getDb();
  const [b] = await db.select({ planId: s.bookings.planId }).from(s.bookings).where(eq(s.bookings.id, ctx.bookingId));
  if (!b?.planId) return { shown: false, message: "This trip came from the catalogue and already has its flights and hotel. Use compare_flights or compare_hotels to change them." };
  ctx.ui({ t: "details", bookingRef: ctx.bookingRef, kind: input.kind, prefill: input.prefill ?? {} });
  return { shown: true, next: `A form to add the ${input.kind} is on the traveller's screen${input.prefill && Object.keys(input.prefill).length ? ", filled with what they told you" : ""}. Tell them in one or two sentences to check it, fill any blank fields from their ${input.kind === "flight" ? "ticket" : "booking confirmation"} and tap Save. Times are local to each airport. Nothing is booked or paid by this. Do not say it is saved until they tell you they saved it.` };
}

export async function getRoute(ctx: ToolCtx, input: { from?: string; to: string }) {
  const pack = await loadPack(ctx);
  const stay = currentStay(pack, ctx.now);
  const find = (q: string | undefined, dflt: string) => {
    const t = (q ?? "").toLowerCase().trim();
    if (!t || t === "hotel" || t === "my hotel") return pack.places[stay.hotelId];
    if (t.includes("airport")) return pack.places[stay.airportId];
    const all = Object.values(pack.places);
    return all.find((p) => p.id === t) ?? all.find((p) => p.name.toLowerCase().includes(t)) ?? all.find((p) => t.includes(p.name.toLowerCase())) ?? pack.places[dflt];
  };
  const from = find(input.from, stay.hotelId);
  const to = find(input.to, stay.hotelId);
  const route = pack.routes.find((r) => r.from === from.id && r.to === to.id) ?? pack.routes.find((r) => r.from === to.id && r.to === from.id);
  if (!route) return { found: false, message: "No saved route between those two places.", savedRoutes: pack.routes.map((r) => `${r.fromName} to ${r.toName}`) };
  const u: UiEvent = { t: "route", routeId: route.id, fromName: route.fromName, toName: route.toName, distance_m: route.distance_m, duration_s: route.duration_s, approximate: route.approximate, url: `/trips/${ctx.bookingRef}/map?route=${encodeURIComponent(route.id)}` };
  ctx.ui(u);
  return { found: true, from: route.fromName, to: route.toName, mode: route.mode, distanceKm: Math.round(route.distance_m / 100) / 10, minutes: Math.round(route.duration_s / 60), approximate: route.approximate, steps: route.steps.slice(0, 6).map((x) => x.instruction), openOnMap: u.url };
}

export async function searchFlightsTool(ctx: ToolCtx, input: { itemId: string; date?: string }) {
  const db = await getDb();
  const [item] = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.id, input.itemId), eq(s.bookingItems.bookingId, ctx.bookingId)));
  if (!item || item.kind !== "flight") throw new GateError("NOT_FOUND", 404, "That flight is not on this booking. Use get_itinerary to find itemId values.");
  const d = item.details as Record<string, string | number>;
  const pack = await loadPack(ctx);
  const f = pack.flights.find((x) => x.flight_no === d.flightNo)!;
  const anchor = d.leg === "outbound" ? "arrive" : "depart";
  const date = input.date ?? (anchor === "arrive" ? localDate(new Date(String(d.arriveAt)), f.to_tz) : localDate(new Date(String(d.departAt)), f.from_tz));
  const alts = await searchFlights({ from: String(d.from), to: String(d.to), date, pax: pack.booking.pax, anchor });
  return {
    currentFlight: { flightNo: d.flightNo, farePerTravellerInr: d.farePerPaxInr, departsUtc: d.departAt },
    date,
    note: "In this prototype a flight can move to another time on the same travel day.",
    source: MOCK_SOURCE,
    liveOffers: await liveOffers(String(d.from), String(d.to), date, pack.booking.pax),
    alternatives: alts.filter((a) => a.id !== d.flightId && a.available).slice(0, 6).map((a) => ({
      flightId: a.id, flightNo: a.flightNo, carrier: a.carrierName, departsUtc: a.departAt, departsLocal: localTime(new Date(a.departAt), f.from_tz), arrivesLocal: localTime(new Date(a.arriveAt), f.to_tz),
      farePerTravellerInr: a.farePerPaxInr, differenceVsCurrentInr: a.farePerPaxInr - Number(d.farePerPaxInr), changeFeeInr: a.changeFeeInr, seatsLeft: a.seatsLeft,
      changeCostInr: (Math.max(0, a.farePerPaxInr - Number(d.farePerPaxInr)) + a.changeFeeInr) * pack.booking.pax,
    })),
  };
}

/** Offers from enabled REAL providers (official APIs, user-supplied keys). Empty when only the mock is on. */
async function liveOffers(from: string, to: string, date: string, pax: number) {
  const out: { provider: string; source: string; validUntil: string; summary: string; totalInr: number; breakup: unknown }[] = [];
  for (const p of flightProviders().filter((x) => x.name !== "mock")) {
    try { for (const o of await p.search({ from, to, date, pax })) out.push({ provider: o.provider, source: o.source, validUntil: o.validUntil, summary: o.summary, totalInr: o.totalInr, breakup: o.breakup }); } catch { /* provider down: skip it */ }
  }
  return out;
}

/**
 * Flight changes happen on the platform where the ticket was bought. We cannot log in there for the traveller (these sites
 * have no sign-in for other apps), so this shows a picker that opens each platform's own page, then a form to record the new
 * flight, which goes through the confirmation gate. Nothing is searched, booked or changed here.
 */
export async function connectPlatformTool(ctx: ToolCtx, input: { itemId?: string }, opts: { silent?: boolean } = {}) {
  const db = await getDb();
  const flights = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, ctx.bookingId), eq(s.bookingItems.kind, "flight"), eq(s.bookingItems.status, "confirmed")));
  const sorted = flights.slice().sort((a, b) => String(a.details.departAt).localeCompare(String(b.details.departAt)));
  const item = (input.itemId ? sorted.find((f) => f.id === input.itemId) : sorted.find((f) => new Date(String(f.details.departAt)).getTime() > ctx.now.getTime())) ?? sorted[0];
  if (!item) throw new GateError("NOT_FOUND", 404, "There is no flight on this booking. Use get_itinerary to find itemId values.");
  const pack = await loadPack(ctx);
  const d = item.details as Record<string, string | number>;
  const pf = pack.flights.find((x) => x.flight_no === d.flightNo && x.from === d.from);
  const fromTz = pf?.from_tz ?? "UTC", toTz = pf?.to_tz ?? "UTC";
  const date = localDate(new Date(String(d.departAt)), fromTz);
  const connected = await connectedPlatforms(ctx.userId, db);
  const flight = {
    flightNo: String(d.flightNo), carrier: String(d.carrierName), from: String(d.from), to: String(d.to), date, leg: String(d.leg), pnr: String(d.pnr), pax: pack.booking.pax,
    departIso: `${date}T${localTime(new Date(String(d.departAt)), fromTz)}`, arriveIso: `${localDate(new Date(String(d.arriveAt)), toTz)}T${localTime(new Date(String(d.arriveAt)), toTz)}`,
    departsLocal: `${fmtDate(date)}, ${localTime(new Date(String(d.departAt)), fromTz)}`, arrivesLocal: `${fmtDate(localDate(new Date(String(d.arriveAt)), toTz))}, ${localTime(new Date(String(d.arriveAt)), toTz)}`,
  };
  const platforms = platformLinks({ from: flight.from, to: flight.to, date, pax: pack.booking.pax }).map((p) => ({ ...p, connected: connected.includes(p.id) }));
  if (!opts.silent) ctx.ui({ t: "platforms", bookingRef: ctx.bookingRef, itemId: item.id, flight, platforms });
  return {
    shown: true, flight, itemId: item.id, connectedPlatforms: connected,
    next: "A platform picker is on the traveller's screen. Explain in plain words: they log in on MakeMyTrip, Goibibo, Cleartrip or ixigo themselves (we cannot log in for them and never see their password), change the ticket there, then come back and enter the new flight on the card. They review it and tap Confirm; only then does the trip and offline guide update. Do not offer sample flights or prices.",
  };
}

/**
 * The agent compares real fares for the traveller's flight request across the OFFICIAL price APIs that are configured
 * (Amadeus, Duffel), ranks them, and then sends the traveller to the platform of their choice (pre-filled search) to pay.
 * It cannot log in to or read prices from MakeMyTrip, Goibibo, Cleartrip or ixigo (they offer no access), so it says so.
 * With no price API configured it falls back to the platform picker and says it has no live prices.
 */
export async function compareFlightsTool(ctx: ToolCtx, input: { itemId?: string; date?: string; from?: string; to?: string }) {
  const base = await connectPlatformTool(ctx, { itemId: input.itemId }, { silent: true });
  const flight = base.flight;
  const q = { from: (input.from ?? flight.from).toUpperCase(), to: (input.to ?? flight.to).toUpperCase(), date: input.date ?? flight.date, pax: flight.pax };
  const pack = await loadPack(ctx);
  const pf = pack.flights.find((x) => x.from === q.from) ?? pack.flights.find((x) => x.flight_no === flight.flightNo);
  const pt = pack.flights.find((x) => x.to === q.to);
  const links = platformLinks(q).map((p) => ({ ...p, connected: base.connectedPlatforms.includes(p.id) }));
  const res = await compareFlightsOrSample({ ...q, fromTz: pf?.from === q.from ? pf.from_tz : undefined, toTz: pt?.to_tz });
  if (!res.offers.length && !res.providers.some((p) => p.ok)) {
    ctx.ui({ t: "platforms", bookingRef: ctx.bookingRef, itemId: base.itemId, flight, platforms: links });
    return { configured: false, shown: "platform picker", next: "The price source did not answer, so you CANNOT compare prices right now. Say so plainly. A picker to open MakeMyTrip, Goibibo, Cleartrip or ixigo (pre-filled) is on screen: tell the traveller to log in there, pay there, then enter the booking on the card. Never invent or estimate a price." };
  }
  ctx.ui({ t: "compare", bookingRef: ctx.bookingRef, itemId: base.itemId, query: q, flight, sample: !!res.sample, providers: res.providers, offers: res.offers.map((o) => ({ id: o.id, providerLabel: o.providerLabel, source: o.source, totalInr: o.totalInr, perTravellerInr: o.perTravellerInr, breakup: o.breakup, facts: o.facts, validUntil: o.validUntil, platformPrices: o.platformPrices })), cheapestId: res.cheapestId, fastestId: res.fastestId, platforms: links });
  const cheapest = res.offers[0];
  const loggedIn = base.connectedPlatforms[0] ? PLATFORMS[base.connectedPlatforms[0]].name : undefined;
  const onPlatform = cheapest?.platformPrices?.find((p) => p.platform === base.connectedPlatforms[0]);
  return {
    configured: true, sample: !!res.sample, query: q, providers: res.providers, loggedInPlatform: loggedIn ?? null,
    offers: res.offers.map((o) => ({ source: o.source, flight: `${o.facts.carrier} ${o.facts.flightNo}`, departsLocal: o.facts.departLocal, arrivesLocal: o.facts.arriveLocal, stops: o.facts.stops, totalInr: o.totalInr, perTravellerInr: o.perTravellerInr, platformPrices: o.platformPrices?.map((p) => ({ platform: p.name, totalInr: p.totalInr })) })),
    cheapest: cheapest ? `${cheapest.facts.carrier} ${cheapest.facts.flightNo} at ₹${cheapest.totalInr} for ${q.pax}${onPlatform ? ` (₹${onPlatform.totalInr} on ${onPlatform.name})` : ""}` : null,
    next: !res.offers.length
      ? "The price source returned no flights for this route and day. Say so, and suggest another date or the platform picker."
      : res.sample
        ? `A comparison of SAMPLE fares from the Safar Saathi mock partner API is on screen, with each booking platform's sample price. Summarise the cheapest and the fastest in 2-3 sentences and say clearly these are sample prices, not live prices. Then tell the traveller to pay on the platform they are logged in to${loggedIn ? ` (${loggedIn})` : " (they choose it at the top of the chat)"}: the "Pay on ..." button opens that site, where they log in, find the flight and pay. Safar Saathi cannot take payment. After paying, they record the booking on the card.`
        : "A comparison table is on the traveller's screen with live fares from official price APIs. Summarise the cheapest and the fastest in 2-3 sentences. Say these are reference fares: MakeMyTrip, Goibibo, Cleartrip and ixigo can show a different price, so the traveller should open the platform they are logged in to from the card, check the same flight, and pay there. You cannot log in to or read prices from those platforms and Safar Saathi cannot take the payment. After paying, the traveller records the booking on the card.",
  };
}

/**
 * Hotel changes: the agent compares live hotel prices near the traveller's stay from the official price API (when configured),
 * then sends them to MakeMyTrip, Goibibo, Cleartrip or ixigo to book and pay (they log in there; we cannot, and cannot read their
 * prices). They record the booking afterwards through the Confirm gate. With no price source it says so and shows the details to enter.
 */
export async function compareHotelsTool(ctx: ToolCtx, input: { extraNights?: number; nights?: number; checkin?: string }) {
  const db = await getDb();
  const rows = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, ctx.bookingId), eq(s.bookingItems.kind, "hotel"), eq(s.bookingItems.status, "confirmed")));
  const cur = rows.sort((a, b) => String(a.details.checkinDate).localeCompare(String(b.details.checkinDate))).at(-1);
  if (!cur) throw new GateError("NOT_FOUND", 404, "No hotel on this booking.");
  const d = cur.details as Record<string, string | number>;
  const pack = await loadPack(ctx);
  const nights = Math.min(14, Math.max(1, input.nights ?? input.extraNights ?? 1));
  const checkin = input.checkin ?? String(d.checkoutDate);
  const query = { checkin, checkout: addDays(checkin, nights), nights, rooms: Number(d.rooms), adults: pack.booking.pax, city: String(d.cityName ?? d.city) };
  const connected = await connectedPlatforms(ctx.userId, db);
  const res = await compareHotelsOrSample({ lat: Number(d.lat), lon: Number(d.lon), checkin: query.checkin, checkout: query.checkout, rooms: query.rooms, adults: query.adults, cityName: query.city, citySlug: String(d.city ?? "") });
  const platforms = hotelLinks().map((p) => ({ ...p, connected: connected.includes(p.id as never) }));
  ctx.ui({ t: "hotels", bookingRef: ctx.bookingRef, itemId: cur.id, configured: res.configured, sample: !!res.sample, current: { name: String(d.name), city: query.city, address: String(d.address), checkin: String(d.checkinDate), checkout: String(d.checkoutDate), rooms: query.rooms, lat: Number(d.lat), lon: Number(d.lon) }, query, providers: res.providers, offers: res.offers, cheapestId: res.cheapestId, platforms });
  const loggedIn = connected[0] ? PLATFORMS[connected[0]].name : undefined;
  if (!res.configured || (!res.offers.length && !res.providers.some((p) => p.ok))) return { configured: false, query, next: "The hotel price source did not answer, so you CANNOT compare prices right now. Say so plainly. A card with links to MakeMyTrip, Goibibo, Cleartrip and ixigo hotel search and the details to enter is on screen: tell the traveller to log in there, book and pay there, then record the booking on the card. Never invent a price." };
  return {
    configured: true, sample: !!res.sample, query, providers: res.providers, loggedInPlatform: loggedIn ?? null,
    offers: res.offers.map((o) => ({ hotel: o.hotelName, room: o.roomType, totalInr: o.totalInr, perNightInr: o.perNightInr, refundable: o.refundable, source: o.source, platformPrices: o.platformPrices?.map((p) => ({ platform: p.name, totalInr: p.totalInr })) })),
    cheapest: res.offers[0] ? `${res.offers[0].hotelName} at ₹${res.offers[0].totalInr} for ${nights} night(s)` : null,
    next: !res.offers.length
      ? "The price source returned no hotels for those dates. Say so and suggest other dates or searching on a platform from the card."
      : res.sample
        ? `A comparison of SAMPLE hotel prices from the Safar Saathi mock partner API is on screen, with each booking platform's sample price. Summarise the cheapest in 2 sentences and say clearly these are sample prices, not live prices. Tell the traveller to book and pay on the platform they are logged in to${loggedIn ? ` (${loggedIn})` : " (they choose it at the top of the chat)"} using the "Pay on ..." button; Safar Saathi cannot take payment. Extending a stay does not move the flight. After booking they record it on the card and tap Yes.`
        : "A hotel comparison is on screen with live prices from an official API. Summarise the cheapest in 2 sentences. These are reference prices: the booking platforms can differ, so the traveller opens the platform they are logged in to from the card, books and pays there. You cannot log in, read those prices or take payment. After booking they record it on the card and tap Yes.",
  };
}

export async function searchStaysTool(ctx: ToolCtx, input: { extraNights: number }) {
  const db = await getDb();
  const items = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, ctx.bookingId), eq(s.bookingItems.kind, "hotel"), eq(s.bookingItems.status, "confirmed")));
  const last = items.sort((a, b) => String(a.details.checkinDate).localeCompare(String(b.details.checkinDate))).at(-1);
  if (!last) throw new GateError("NOT_FOUND", 404, "No hotel on this booking.");
  const d = last.details as Record<string, string | number>;
  const a = await stayAvailability({ hotelId: String(d.hotelId), checkin: String(d.checkoutDate), nights: input.extraNights, rooms: Number(d.rooms) });
  return { hotel: d.name, currentCheckOut: d.checkoutDate, newCheckOut: addDays(String(d.checkoutDate), input.extraNights), available: a.available, rooms: d.rooms, perNight: a.perNight, hotelTotalInr: a.totalInr, note: "Extending the last stop also moves your return flight and airport drop-off. quote_change prices all of it." };
}

export async function quoteChange(ctx: ToolCtx, input: { kind: "flight_change" | "hotel_extend"; itemId?: string; newFlightId?: string; newFlightIds?: string[]; extraNights?: number }) {
  const ids = input.kind === "flight_change" ? (input.newFlightIds?.length ? input.newFlightIds : input.newFlightId ? [input.newFlightId] : []).slice(0, 3) : [undefined];
  const cards: ReviewCard[] = [];
  let lastErr: unknown;
  for (const nf of ids) {
    try {
      const card = await createQuote({ bookingRef: ctx.bookingRef, userId: ctx.userId, kind: input.kind, params: { itemId: input.itemId, newFlightId: nf, extraNights: input.extraNights } as never, chaos: ctx.chaos });
      cards.push(card);
      ctx.ui({ t: "review", card });
    } catch (e) { lastErr = e; }
  }
  if (!cards.length) throw lastErr ?? new GateError("BAD_REQUEST", 400, "Nothing to quote.");
  const allBlocked = cards.every((c) => c.blocked);
  return {
    options: cards.map((c) => ({ quoteId: c.quoteId, blocked: c.blocked, price: inr(c.totalInr), totalInr: c.totalInr, breakup: c.breakup, source: c.source, validUntil: c.validUntil, after: c.after, rules: c.rules })),
    before: cards[0].before,
    next: allBlocked ? "Every option is above the price limit. Call escalate_human instead of asking the traveller to confirm." : "An option list is now on the traveller's screen, each with its price breakup and Yes / No. Tell them to compare and tap Yes on one. You cannot confirm for them.",
  };
}

export async function applyChangeTool(ctx: ToolCtx, input: { quoteId: string }) {
  try {
    const receipt = await applyChange({ quoteId: input.quoteId, token: ctx.confirmationToken, userId: ctx.userId, threadId: ctx.threadId });
    ctx.ui({ t: "receipt", receipt });
    return { applied: true, receipt };
  } catch (e) {
    if (e instanceof GateError && e.code === "PRICE_CHANGED") {
      const card = (e.extra as { newQuote: ReviewCard }).newQuote;
      ctx.ui({ t: "review", card });
      return { applied: false, error: "PRICE_CHANGED", message: "The price moved. A new review card is on screen. Explain the change.", newPriceDeltaInr: card.priceDeltaInr };
    }
    if (e instanceof GateError && e.code === "NO_TOKEN") {
      return { applied: false, error: "CONFIRMATION_REQUIRED", message: "Nothing changed. Only the traveller's Confirm tap on the review card can apply a change. Ask them to tap Confirm." };
    }
    throw e;
  }
}

export async function escalateHuman(ctx: ToolCtx, input: { summary: string; severity?: number }) {
  const rubric = rateSeverity(input.summary).severity;
  const claimed = [1, 2, 3].includes(Number(input.severity)) ? (Number(input.severity) as Severity) : 3;
  const severity = Math.min(rubric, claimed) as Severity; // the more severe of rubric and model
  const c = await openCase({ bookingId: ctx.bookingId, channel: ctx.channel, severity, summary: input.summary });
  ctx.ui({ t: "case", caseRef: c.caseRef, severity, slaSeconds: SLA_SECONDS[severity], summary: input.summary });
  return {
    caseRef: c.caseRef, severity, targetResponseSeconds: SLA_SECONDS[severity],
    message: severity === 1 ? "A person has been paged. Tell the traveller you will stay with them, but you cannot close this case: only a human can." : "A person on our team will follow up.",
    agentMayCloseCase: false,
  };
}

export async function sendSms(ctx: ToolCtx, input: { body: string }) {
  const db = await getDb();
  const [u] = await db.select().from(s.users).where(eq(s.users.id, ctx.userId));
  if (!u?.phoneE164) throw new GateError("NOT_FOUND", 404, "No registered phone number for this traveller.");
  const body = input.body.slice(0, 160);
  const r = await getSmsAdapter().send(u.phoneE164, body);
  await db.insert(s.smsMessages).values({ providerMessageId: r.id, direction: "out", fromMasked: maskPhone(u.phoneE164), body });
  return { sent: true, to: maskPhone(u.phoneE164), length: body.length, simulated: r.stub };
}

/* ------------------------------ AI SDK wiring ------------------------------ */

const Id = z.string().uuid();
export const SCHEMAS = {
  get_itinerary: z.object({}),
  get_route: z.object({ from: z.string().max(80).optional().describe("Place name, or 'hotel' / 'airport'. Defaults to the hotel."), to: z.string().max(80).describe("Place name, or 'hotel' / 'airport'.") }),
  search_flights: z.object({ itemId: Id.describe("Booked flight itemId from get_itinerary"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  compare_flights: z.object({ itemId: Id.optional().describe("Booked flight itemId. Defaults to the next upcoming flight."), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Travel date the traveller wants, YYYY-MM-DD. Defaults to the booked flight's day."), from: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("IATA origin if different from the booked flight"), to: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("IATA destination if different") }),
  compare_hotels: z.object({ extraNights: z.number().int().min(1).max(14).optional().describe("Nights to add after the current check-out"), nights: z.number().int().min(1).max(14).optional().describe("Nights for a different stay"), checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Check-in date if not the current check-out") }),
  connect_platform: z.object({ itemId: Id.optional().describe("Booked flight itemId from get_itinerary. Defaults to the next upcoming flight.") }),
  search_stays: z.object({ extraNights: z.number().int().min(1).max(3) }),
  add_trip_details: z.object({
    kind: z.enum(["flight", "hotel"]).describe("What is missing from the trip"),
    prefill: z.object({
      airline: z.string().max(60).optional(), flightNo: z.string().max(10).optional(), from: z.string().max(3).optional().describe("IATA code"), to: z.string().max(3).optional().describe("IATA code"),
      departLocal: z.string().max(16).optional().describe("YYYY-MM-DDTHH:mm, local to the departure airport"), arriveLocal: z.string().max(16).optional().describe("YYYY-MM-DDTHH:mm, local to the arrival airport"), pnr: z.string().max(12).optional(),
      name: z.string().max(100).optional(), address: z.string().max(200).optional(), city: z.string().max(60).optional(), checkin: z.string().max(10).optional().describe("YYYY-MM-DD"), checkout: z.string().max(10).optional().describe("YYYY-MM-DD"), phone: z.string().max(30).optional(),
    }).optional().describe("Only details the traveller actually told you. Never guess."),
  }),
  search_web: z.object({ query: z.string().min(3).max(200).describe("A travel information question, e.g. visa rules or opening hours") }),
  quote_change: z.object({ kind: z.enum(["flight_change", "hotel_extend"]), itemId: Id.optional().describe("flight_change: booked flight itemId"), newFlightId: Id.optional().describe("flight_change: one flightId from search_flights"), newFlightIds: z.array(Id).min(1).max(3).optional().describe("flight_change: up to 3 flightIds to show as an option list"), extraNights: z.number().int().min(1).max(3).optional().describe("hotel_extend: nights to add") }),
  apply_change: z.object({ quoteId: Id }),
  refresh_offline_pack: z.object({}),
  escalate_human: z.object({ summary: z.string().min(3).max(400), severity: z.number().int().min(1).max(3).optional() }),
  send_sms: z.object({ body: z.string().min(1).max(160) }),
} as const;

export const DESCRIPTIONS: Record<ToolName, string> = {
  get_itinerary: "Read the traveller's trip: next plans, pickup, hotel, local time, flights (with itemId). Call this first for any trip question.",
  get_route: "Get a saved map route and steps between two places on the trip (e.g. hotel to Colosseum).",
  search_flights: "Find alternative flights for a booked flight on the same route and day.",
  compare_flights: "Use FIRST for any request to change, move, reschedule or rebook a FLIGHT, or to book a new one. Compares real fares from the official price APIs that are configured, then shows the traveller a comparison and pre-filled links to MakeMyTrip, Goibibo, Cleartrip and ixigo where they pay. If no price API is configured it shows the platform picker instead. Does not book, pay or change anything.",
  compare_hotels: "Use FIRST for any request to extend, change or move a HOTEL stay. Compares live hotel prices near the traveller's stay from the official price API (when configured) and shows links to MakeMyTrip, Goibibo, Cleartrip and ixigo where they book and pay, plus a form to record the booking. Does not book, pay or change anything.",
  connect_platform: "Use only when the traveller just wants the platform links without a price comparison, or wants to cancel or get a refund for a FLIGHT. Shows a picker to open MakeMyTrip, Goibibo, Cleartrip or ixigo (the traveller logs in there themselves) and a form to record the new flight. Does not search, price or change anything.",
  search_stays: "Check availability to extend the stay at the last hotel by 1 to 3 nights.",
  add_trip_details: "Use when the trip has no flight or no hotel (get_itinerary missingDetails) or the traveller wants to add a flight or hotel they forgot. Shows a form on their screen, prefilled with only what they told you, that they check and Save themselves. Does not save, book or pay anything.",
  search_web: "Look up general travel information with a web search API. Cites sources. Never a booking price.",
  quote_change: "Price a HOTEL EXTENSION (kind hotel_extend) and show the traveller a review card with a price breakup and Yes / No. Never use it for flights (use connect_platform). Does NOT change anything.",
  apply_change: "Apply a quoted change. Needs the traveller's Confirm tap; without it this does nothing. Never claim a change is done unless this returns applied: true.",
  refresh_offline_pack: "Server-side job (not callable by the model): regenerates the affected offline guide rules after a confirmed change.",
  escalate_human: "Open a case for a human agent. Use for safety, medical, lost passport, stranded, missed connection, no-show, anything over the price limit, or missing data.",
  send_sms: "Send a short SMS (max 160 characters) to the traveller's registered phone.",
};

/** Run any tool by name with validated input. Shared by the LLM path and the demo agent. */
export async function runTool(name: ToolName, rawInput: unknown, ctx: ToolCtx, opts: { internal?: boolean; fromModel?: boolean } = {}) {
  if (name === "refresh_offline_pack" && !opts.internal) throw new GateError("FORBIDDEN", 403, "refresh_offline_pack is a server-side job. It runs only after apply_change succeeds.");
  const input = SCHEMAS[name].parse(rawInput ?? {}) as never;
  if (opts.fromModel && name === "quote_change" && (input as { kind: string }).kind === "hotel_extend") {
    return { error: "USE_PLATFORM", message: "Stay changes are not quoted from sample data. Call compare_hotels so the traveller books on their own platform." };
  }
  if (opts.fromModel && name === "quote_change" && (input as { kind: string }).kind === "flight_change") {
    return { error: "USE_PLATFORM", message: "Flight changes are not quoted from sample data. Call connect_platform so the traveller changes the ticket on their own booking platform." };
  }
  return logged(ctx, name, input, async () => {
    switch (name) {
      case "get_itinerary": return getItinerary(ctx);
      case "get_route": return getRoute(ctx, input);
      case "search_flights": return searchFlightsTool(ctx, input);
      case "connect_platform": return connectPlatformTool(ctx, input);
      case "compare_flights": return compareFlightsTool(ctx, input);
      case "compare_hotels": return compareHotelsTool(ctx, input);
      case "search_stays": return searchStaysTool(ctx, input);
      case "add_trip_details": return addTripDetailsTool(ctx, input);
      case "search_web": return searchWeb((input as { query: string }).query);
      case "refresh_offline_pack": return refreshOfflinePack(ctx.bookingId, "Manual refresh");
      case "quote_change": return quoteChange(ctx, input);
      case "apply_change": return applyChangeTool(ctx, input);
      case "escalate_human": return escalateHuman(ctx, input);
      case "send_sms": return sendSms(ctx, input);
    }
  });
}

/** The fixed allow-list handed to the model. There is no tool that can mint a confirmation token. */
export function aiTools(ctx: ToolCtx, allow: readonly ToolName[] = MODEL_TOOLS) {
  const out: Record<string, any> = {};
  for (const name of allow) {
    out[name] = tool({ description: DESCRIPTIONS[name], inputSchema: SCHEMAS[name] as never, execute: async (input: unknown) => runTool(name, input, ctx, { fromModel: true }) } as never);
  }
  return out;
}
