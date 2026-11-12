import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { GateError } from "@/lib/gate/errors";
import { refreshOfflinePack } from "@/lib/packs/refresh";
import { geocodeAirport, geocodePlace, KNOWN_AIRPORTS, type LatLon } from "@/lib/plans/geo";
import type { StoredPlan } from "@/lib/plans/process";
import { validTz } from "@/lib/plans/schema";
import { zonedToUtc } from "@/lib/time";

/**
 * Flights and hotels that were missing from an uploaded travel plan, added later by the traveller (from the Trip agent's form).
 * These are the traveller's own records ("entered by you"): nothing is booked or paid here. They become normal booking items,
 * and the offline guide is rebuilt so the day plan, map, SOS and help guides use them.
 */
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-04.");
const DT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a date and time like 2026-12-04T10:30.");
const str = (min: number, max: number) => z.string().trim().min(min).max(max);

export const FlightInput = z.object({
  kind: z.literal("flight"),
  airline: str(2, 60),
  flightNo: str(2, 10).transform((v) => v.toUpperCase().replace(/\s+/g, "")),
  from: z.string().trim().regex(/^[A-Za-z]{3}$/, "Use the 3-letter airport code, like DEL.").transform((v) => v.toUpperCase()),
  to: z.string().trim().regex(/^[A-Za-z]{3}$/, "Use the 3-letter airport code, like SGN.").transform((v) => v.toUpperCase()),
  departLocal: DT,
  arriveLocal: DT,
  pnr: z.string().trim().max(12).optional(),
  fromTimezone: z.string().max(60).optional(),
  toTimezone: z.string().max(60).optional(),
});
export const HotelInput = z.object({
  kind: z.literal("hotel"),
  name: str(2, 100),
  address: str(3, 200),
  city: str(2, 60),
  checkin: D,
  checkout: D,
  phone: z.string().trim().max(30).optional(),
  rooms: z.number().int().min(1).max(9).optional(),
  confirmation: z.string().trim().max(30).optional(),
});
export const DetailsInput = z.discriminatedUnion("kind", [FlightInput, HotelInput]);
export type DetailsInputT = z.infer<typeof DetailsInput>;

const near = (a: LatLon, b: LatLon) => Math.abs(a.lat - b.lat) < 0.8 && Math.abs(a.lon - b.lon) < 0.8;
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);

async function loadUploaded(bookingId: string, db: Db) {
  const [b] = await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
  if (!b) throw new GateError("NOT_FOUND", 404, "Trip not found.");
  if (!b.planId) throw new GateError("BAD_REQUEST", 400, "This trip already has its flights and hotels from the catalogue. To change them, use the change flow in the Trip agent.");
  const [plan] = await db.select().from(s.travelPlans).where(eq(s.travelPlans.id, b.planId)).limit(1);
  if (!plan?.extracted) throw new GateError("BAD_REQUEST", 409, "This trip is still being prepared. Try again in a minute.");
  return { b, plan, p: plan.extracted as unknown as StoredPlan };
}

/** Legs follow the order of travel: first flight outbound, last one return, the rest between cities. */
async function relabelLegs(bookingId: string, db: Db) {
  const rows = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, bookingId), eq(s.bookingItems.kind, "flight"), eq(s.bookingItems.status, "confirmed")));
  rows.sort((x, y) => String(x.details.departAt).localeCompare(String(y.details.departAt)));
  for (const [i, r] of rows.entries()) {
    const leg = rows.length === 1 ? "outbound" : i === 0 ? "outbound" : i === rows.length - 1 ? "return" : "intercity";
    if (r.details.leg !== leg) await db.update(s.bookingItems).set({ details: { ...r.details, leg } as never, updatedAt: new Date() }).where(eq(s.bookingItems.id, r.id));
  }
}

/** The trip's date range grows to include anything the traveller adds outside it (the day plan is built from this range). */
async function widenDates(b: typeof s.bookings.$inferSelect, from: string, to: string, db: Db) {
  const startDate = from < b.startDate ? from : b.startDate;
  const endDate = to > b.endDate ? to : b.endDate;
  if (startDate !== b.startDate || endDate !== b.endDate) await db.update(s.bookings).set({ startDate, endDate, updatedAt: new Date() }).where(eq(s.bookings.id, b.id));
}

export async function addFlight(bookingId: string, input: z.infer<typeof FlightInput>, dbIn?: Db) {
  const db = dbIn ?? (await getDb());
  const { b, plan, p } = await loadUploaded(bookingId, db);
  if (input.from === input.to) throw new GateError("BAD_REQUEST", 400, "The flight starts and ends at the same airport. Check the airport codes.");
  const geo = p.geo, airportTz = { ...p.airportTz };
  let changed = false;
  for (const [iata, tzIn] of [[input.from, input.fromTimezone], [input.to, input.toTimezone]] as const) {
    if (!geo.airports[iata]) {
      const hit = await geocodeAirport(iata);
      if (hit) {
        const slug = Object.entries(geo.cities).find(([, c]) => Number.isFinite(c.lat) && near(c, hit))?.[0];
        geo.airports[iata] = { lat: hit.lat, lon: hit.lon, name: hit.name ?? `${iata} airport`, citySlug: slug };
        changed = true;
      }
    }
    if (!airportTz[iata]) {
      const slug = geo.airports[iata]?.citySlug;
      const tz = validTz(tzIn) ? tzIn! : KNOWN_AIRPORTS[iata]?.tz ?? (slug ? geo.cities[slug]?.tz : undefined);
      if (!tz) throw new GateError("BAD_REQUEST", 400, `I do not know the time zone for airport ${iata}. Please tell me the city or country it is in, so the times are right.`);
      airportTz[iata] = tz;
      changed = true;
    }
  }
  const [dd, dt] = input.departLocal.split("T"), [ad, at] = input.arriveLocal.split("T");
  const departAt = zonedToUtc(dd, dt, airportTz[input.from]), arriveAt = zonedToUtc(ad, at, airportTz[input.to]);
  if (!(arriveAt > departAt)) throw new GateError("BAD_REQUEST", 400, "The flight lands before it takes off. Check the times (they are local to each airport).");
  const have = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, b.id), eq(s.bookingItems.kind, "flight"), eq(s.bookingItems.status, "confirmed")));
  if (have.some((f) => f.details.flightNo === input.flightNo && f.date === dd)) throw new GateError("BAD_REQUEST", 409, `${input.flightNo} on ${dd} is already on your trip.`);

  await db.insert(s.bookingItems).values({
    bookingId: b.id, kind: "flight", refId: null, date: dd, priceInr: 0, status: "confirmed",
    details: { flightId: null, flightNo: input.flightNo, carrierName: input.airline, from: input.from, to: input.to, departAt: departAt.toISOString(), arriveAt: arriveAt.toISOString(), farePerPaxInr: 0, pax: b.pax, leg: "intercity", pnr: input.pnr ?? "", changeFeeInr: 0, terminal: null, fareRules: "As in your ticket.", fromUpload: true, enteredByTraveller: true },
  } as never);
  if (changed) await db.update(s.travelPlans).set({ extracted: { ...(plan.extracted as object), geo, airportTz } as never, updatedAt: new Date() }).where(eq(s.travelPlans.id, plan.id));
  await relabelLegs(b.id, db);
  await widenDates(b, dd, ad, db);
  const r = await refreshOfflinePack(b.id, `Flight ${input.flightNo} added`, db);
  return { summary: `${input.airline} ${input.flightNo}, ${input.from} to ${input.to}, ${dd} ${dt}`, packVersion: r.version, guideUpdated: r.ok, ...(r.ok ? {} : { message: r.message }) };
}

export async function addHotel(bookingId: string, input: z.infer<typeof HotelInput>, dbIn?: Db) {
  const db = dbIn ?? (await getDb());
  const { b, p } = await loadUploaded(bookingId, db);
  const nights = nightsBetween(input.checkin, input.checkout);
  if (nights < 1) throw new GateError("BAD_REQUEST", 400, "Check-out must be after check-in.");
  if (nights > 60) throw new GateError("BAD_REQUEST", 400, "That is more than 60 nights. Check the dates.");
  const cityKey = input.city.toLowerCase();
  const byDates = p.cities.find((c) => c.from <= input.checkin && input.checkin < c.to);
  const slug = p.geo.citySlug[cityKey]
    ?? Object.entries(p.geo.citySlug).find(([k]) => k.includes(cityKey) || cityKey.includes(k))?.[1]
    ?? (byDates ? p.geo.citySlug[byDates.name.toLowerCase()] : undefined)
    ?? Object.keys(p.geo.cities)[0];
  const cityName = p.cities.find((c) => p.geo.citySlug[c.name.toLowerCase()] === slug)?.name ?? input.city;
  const centre = p.geo.cities[slug];
  const have = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, b.id), eq(s.bookingItems.kind, "hotel"), eq(s.bookingItems.status, "confirmed")));
  if (have.some((h) => String(h.details.name).toLowerCase() === input.name.toLowerCase() && h.details.checkinDate === input.checkin)) throw new GateError("BAD_REQUEST", 409, `${input.name} from ${input.checkin} is already on your trip.`);
  const hit = await geocodePlace(input.name, cityName, centre && Number.isFinite(centre.lat) ? centre : null, input.address);
  const at = hit ?? (centre && Number.isFinite(centre.lat) ? { lat: centre.lat, lon: centre.lon } : { lat: 0, lon: 0 });

  await db.insert(s.bookingItems).values({
    bookingId: b.id, kind: "hotel", refId: null, date: input.checkin, priceInr: 0, status: "confirmed",
    details: { hotelId: null, name: input.name, address: input.address, addressLocal: input.address, phone: input.phone ?? "", lat: at.lat, lon: at.lon, locationExact: !!hit, checkinDate: input.checkin, checkoutDate: input.checkout, nights, rooms: input.rooms ?? Math.max(1, Math.ceil(b.pax / 2)), roomType: "as booked", rateInr: 0, checkinTime: "", checkoutTime: "", city: slug, cityName, rules: ["Check your hotel confirmation for check-in time and rules."], confirmation: input.confirmation ?? null, fromUpload: true, enteredByTraveller: true },
  } as never);
  await widenDates(b, input.checkin, input.checkout, db);
  const r = await refreshOfflinePack(b.id, `Hotel ${input.name} added`, db);
  return { summary: `${input.name}, ${cityName}, ${input.checkin} to ${input.checkout} (${nights} night${nights > 1 ? "s" : ""})`, pinExact: !!hit, packVersion: r.version, guideUpdated: r.ok, ...(r.ok ? {} : { message: r.message }) };
}

export async function addTripDetails(bookingId: string, input: DetailsInputT, db?: Db) {
  const r = input.kind === "flight" ? await addFlight(bookingId, input, db) : await addHotel(bookingId, input, db);
  const d = db ?? (await getDb());
  await d.insert(s.events).values({ name: "trip_details_added", bookingId, props: { kind: input.kind } }).catch(() => {});
  return r;
}
