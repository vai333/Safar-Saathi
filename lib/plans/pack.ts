import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import type { OfflinePack, PackDay, PackFlight, PackItem, PackMapCity, PackPlace, PackStay } from "@/lib/packs/types";
import type { SavedRoute } from "@/lib/map/routes";
import { approximateRoute } from "@/lib/map/routes";
import { cachedRoute, routeKey, type CachedRoute } from "@/lib/map/route-cache";
import { fetchOsrmRoute } from "@/lib/map/osrm";
import { haversineM } from "@/lib/geo";
import { addDays, localDate, localTime } from "@/lib/time";
import { DESTINATIONS } from "@/lib/seed/data";
import type { StoredPlan } from "./process";

type BaseContent = Omit<OfflinePack, "packVersion" | "contentHash" | "builtAt" | "rules" | "rulesMeta" | "ruleSet">;
const NOT_GIVEN = "not in your documents";
export const PLAN_DISCLAIMER = "Built from the documents you uploaded. Check important details against your bookings.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastOsrm = 0;

/** Real road/foot route: our pre-built cache, then a polite live OSM routing call (build time only), then a labelled straight line. */
async function planRoute(ids: { id: string; from: string; to: string; fromName: string; toName: string }, a: PackPlace, b: PackPlace, saved: Record<string, CachedRoute>, budget: { live: number }): Promise<SavedRoute> {
  const mode = haversineM(a, b) < 1500 ? "walk" : "drive";
  const key = routeKey(a, b, mode);
  let r: CachedRoute | null = saved[key] ?? cachedRoute(a, b, mode);
  if (!r && budget.live > 0 && process.env.PLAN_ROUTING !== "off") {
    budget.live--;
    const wait = 1100 - (Date.now() - lastOsrm);
    if (wait > 0) await sleep(wait);
    lastOsrm = Date.now();
    try { r = await fetchOsrmRoute(a, b, mode); saved[key] = r; } catch { r = null; }
  }
  if (r) return { ...ids, mode: r.mode, distance_m: r.distance_m, duration_s: r.duration_s, approximate: false, geojson: r.geojson, steps: r.steps };
  return { ...ids, ...approximateRoute(a, b, mode, b.name) };
}

const DEFAULT_EMERGENCY = { general: "112", police: "112", ambulance: "112", verified: false };

/**
 * The offline bundle for an UPLOADED travel plan: same shape as a catalogue trip, so the guide, offline map, SOS, offline
 * assistant and agent all work. Flights and hotels come from the booking's items (so confirmed changes show up); activities,
 * transfers, contacts and geography come from the stored, model-extracted plan.
 */
export async function buildPlanPackContent(b: typeof s.bookings.$inferSelect, db: Db): Promise<BaseContent> {
  const [plan] = await db.select().from(s.travelPlans).where(eq(s.travelPlans.id, b.planId!)).limit(1);
  if (!plan?.extracted) throw new Error("PLAN_NOT_READY");
  const p = plan.extracted as unknown as StoredPlan;
  const items = await db.select().from(s.bookingItems).where(and(eq(s.bookingItems.bookingId, b.id), eq(s.bookingItems.status, "confirmed")));
  const cityOf = (name: string | undefined) => (name ? p.geo.citySlug[name.toLowerCase()] : undefined);
  const cities = p.cities.map((c) => ({ ...c, slug: p.geo.citySlug[c.name.toLowerCase()], ...p.geo.cities[p.geo.citySlug[c.name.toLowerCase()]] }));
  const tzOfCity = (slug: string) => p.geo.cities[slug]?.tz ?? "UTC";
  const airportTz = (iata: string) => p.airportTz[iata] ?? "UTC";

  /* places */
  const places: Record<string, PackPlace> = {};
  for (const [iata, a] of Object.entries(p.geo.airports)) {
    places[`airport_${iata}`] = { id: `airport_${iata}`, kind: "airport", city: a.citySlug ?? "home", name: a.name, name_local: a.name, address: a.name, address_local: a.name, lat: a.lat, lon: a.lon };
  }
  for (const c of cities) {
    places[`city_${c.slug}`] = { id: `city_${c.slug}`, kind: "poi", city: c.slug, name: `${c.name} centre`, name_local: `${c.name} centre`, address: `${c.name}, ${c.country}`, address_local: `${c.name}, ${c.country}`, phone: NOT_GIVEN, lat: c.lat, lon: c.lon , ...(p.photos?.[`city:${c.slug}`] ? { image: p.photos[`city:${c.slug}`] } : {}) };
  }
  const hotelItems = items.filter((i) => i.kind === "hotel").sort((x, y) => String(x.details.checkinDate).localeCompare(String(y.details.checkinDate)));
  hotelItems.forEach((h, i) => {
    const d = h.details as Record<string, string | number>;
    const id = `hotel_${i}`;
    places[id] = { id, kind: "hotel", city: String(d.city), name: String(d.name), name_local: String(d.name), address: String(d.address), address_local: String(d.addressLocal ?? d.address), lat: Number(d.lat), lon: Number(d.lon), phone: String(d.phone || NOT_GIVEN) };
  });
  const poiId = new Map<string, string>();
  for (const [k, g] of Object.entries(p.geo.places)) {
    const id = `poi_${Object.keys(places).length}`;
    places[id] = { id, kind: "poi", city: g.citySlug, name: g.name, name_local: g.name, address: g.name, address_local: g.name, lat: g.lat, lon: g.lon , ...(p.photos?.[`place:${k}`] ? { image: p.photos[`place:${k}`] } : {}) };
    poiId.set(k, id);
  }

  /* flights (from booking items, so recorded changes appear) */
  const flights: PackFlight[] = items.filter((i) => i.kind === "flight").map((fi) => {
    const d = fi.details as Record<string, string>;
    return { leg: d.leg as PackFlight["leg"], flight_no: d.flightNo, carrier: d.carrierName, from: d.from, to: d.to, from_tz: airportTz(d.from), to_tz: airportTz(d.to), depart_at: d.departAt, arrive_at: d.arriveAt, pnr: d.pnr || NOT_GIVEN };
  }).sort((x, y) => x.depart_at.localeCompare(y.depart_at));

  /* stays */
  const transfers = p.transfers ?? [];
  const consulateFor = (country: string) => (country.toLowerCase() === "india" ? { name: "In India: no embassy needed. National emergency number 112", address: "Police 100, ambulance 108, tourist helpline 1800 11 1363", phone: "112", sample: true as const } : { name: `Indian embassy or consulate for ${country}`, address: NOT_GIVEN, phone: NOT_GIVEN, sample: true as const });
  const emergencyFor = (slug: string, country: string) => DESTINATIONS.find((x) => x.slug === slug)?.emergency ?? DESTINATIONS.find((x) => x.country.toLowerCase() === country.toLowerCase())?.emergency ?? (country.toLowerCase() === "india" ? { general: "112", police: "100", ambulance: "108", verified: true } : DEFAULT_EMERGENCY);
  const airportFor = (slug: string): string => {
    const arr = flights.find((f) => p.geo.airports[f.to]?.citySlug === slug) ?? flights.find((f) => p.geo.airports[f.from]?.citySlug === slug);
    if (arr) return `airport_${p.geo.airports[arr.to]?.citySlug === slug ? arr.to : arr.from}`;
    return Object.keys(places).find((k) => k.startsWith("airport_") && places[k].city === slug) ?? `city_${slug}`;
  };
  const codes = Object.keys(p.geo.airports);
  const isAirport = (s: string) => /airport|terminal|arrivals|departures/i.test(s) || codes.some((c) => new RegExp(`\\b${c}\\b`).test(s));
  const driverFor = (slug: string, date: string, kind: "pickup" | "drop") => {
    const t = transfers.find((x) => (cityOf(x.city) ?? slug) === slug && x.date === date && (kind === "pickup" ? isAirport(x.from) : isAirport(x.to)))
      ?? transfers.find((x) => (cityOf(x.city) ?? slug) === slug && (kind === "pickup" ? isAirport(x.from) : isAirport(x.to)));
    return { name: t?.driver ?? t?.provider ?? NOT_GIVEN, vendor: t?.provider ?? NOT_GIVEN, phone: t?.phone ?? NOT_GIVEN, pickup_code: t?.code ?? NOT_GIVEN, pickup_time: t?.time ? `${t.time} on ${t.date}` : NOT_GIVEN };
  };
  const stays: PackStay[] = [];
  if (hotelItems.length) {
    hotelItems.forEach((h, i) => {
      const d = h.details as Record<string, string | number>;
      const slug = String(d.city), c = cities.find((x) => x.slug === slug) ?? cities[0];
      const drop = driverFor(slug, String(d.checkoutDate), "drop");
      stays.push({ city: slug, cityName: String(d.cityName ?? c.name), tz: tzOfCity(slug), from: String(d.checkinDate), to: String(d.checkoutDate), hotelId: `hotel_${i}`, airportId: airportFor(slug), emergency: emergencyFor(slug, c.country), consulate: consulateFor(c.country), driver: driverFor(slug, String(d.checkinDate), "pickup"), dropDriver: { name: drop.name, vendor: drop.vendor, phone: drop.phone, pickup_code: drop.pickup_code } });
    });
    // a city with no hotel yet (added later, or missing from the documents) keeps a city-centre stay, so the trip has no gaps
    for (const c of cities.filter((x) => !stays.some((st) => st.city === x.slug))) {
      const drop = driverFor(c.slug, c.to, "drop");
      stays.push({ city: c.slug, cityName: c.name, tz: tzOfCity(c.slug), from: c.from, to: c.to, hotelId: `city_${c.slug}`, airportId: airportFor(c.slug), emergency: emergencyFor(c.slug, c.country), consulate: consulateFor(c.country), driver: driverFor(c.slug, c.from, "pickup"), dropDriver: { name: drop.name, vendor: drop.vendor, phone: drop.phone, pickup_code: drop.pickup_code } });
    }
    stays.sort((x, y) => x.from.localeCompare(y.from));
  } else {
    for (const c of cities) {
      const drop = driverFor(c.slug, c.to, "drop");
      stays.push({ city: c.slug, cityName: c.name, tz: tzOfCity(c.slug), from: c.from, to: c.to, hotelId: `city_${c.slug}`, airportId: airportFor(c.slug), emergency: emergencyFor(c.slug, c.country), consulate: consulateFor(c.country), driver: driverFor(c.slug, c.from, "pickup"), dropDriver: { name: drop.name, vendor: drop.vendor, phone: drop.phone, pickup_code: drop.pickup_code } });
    }
  }

  /* days */
  const days: PackDay[] = [];
  const start = b.startDate, end = b.endDate;
  for (let i = 0, date = start; date <= end && i < 60; i++, date = addDays(start, i)) {
    const c = cities.find((x) => x.from <= date && date < x.to) ?? (date >= cities[cities.length - 1].from ? cities[cities.length - 1] : cities[0]);
    const tz = tzOfCity(c.slug);
    const list: PackItem[] = [];
    for (const f of flights) {
      if (localDate(new Date(f.depart_at), f.from_tz) === date) list.push({ time: localTime(new Date(f.depart_at), f.from_tz), type: "flight", title: `${f.carrier} ${f.flight_no}: ${f.from} to ${f.to}`, notes: `Lands ${localTime(new Date(f.arrive_at), f.to_tz)} local. Booking code ${f.pnr}.`, placeId: places[`airport_${f.from}`] ? `airport_${f.from}` : undefined });
      else if (localDate(new Date(f.arrive_at), f.to_tz) === date) list.push({ time: localTime(new Date(f.arrive_at), f.to_tz), type: "flight", title: `Land in ${f.to}: ${f.carrier} ${f.flight_no}`, notes: `Booking code ${f.pnr}.`, placeId: places[`airport_${f.to}`] ? `airport_${f.to}` : undefined });
    }
    hotelItems.forEach((h, k) => {
      const d = h.details as Record<string, string>;
      if (d.checkinDate === date) list.push({ time: d.checkinTime || "14:00", type: "hotel", title: `Check in at ${d.name}`, notes: d.checkinTime ? undefined : "Check-in time: see your hotel confirmation.", placeId: `hotel_${k}` });
      if (d.checkoutDate === date) list.push({ time: d.checkoutTime || "11:00", type: "hotel", title: `Check out of ${d.name}`, notes: d.checkoutTime ? undefined : "Check-out time: see your hotel confirmation.", placeId: `hotel_${k}` });
    });
    for (const a of (p.activities ?? []).filter((x) => x.date === date)) {
      list.push({ time: a.time ?? "10:00", type: "activity", title: a.title, notes: [a.notes, a.time ? undefined : "Time not in your documents."].filter(Boolean).join(" ") || undefined, placeId: poiId.get(`${a.place ?? a.title}|${a.city}`.toLowerCase()) });
    }
    for (const t of transfers.filter((x) => x.date === date)) {
      list.push({ time: t.time ?? "12:00", type: "transfer", title: `${t.provider ?? "Transfer"}: ${t.from} to ${t.to}`, notes: [t.driver && `Driver ${t.driver}`, t.phone && `phone ${t.phone}`, t.code && `code ${t.code}`, t.time ? undefined : "Time not in your documents."].filter(Boolean).join(", ") || undefined });
    }
    list.sort((x, y) => x.time.localeCompare(y.time));
    days.push({ date, dayNo: i + 1, city: c.slug, cityName: c.name, tz, title: list.find((x) => x.type === "activity")?.title ?? `${c.name}${list.length ? "" : ": free day"}`, items: list });
  }

  /* routes: airport <-> hotel, hotel -> each place in that city (max 24, polite live routing for new places) */
  const saved: Record<string, CachedRoute> = { ...(p.routeCache ?? {}) };
  const budget = { live: 20 };
  const routes: SavedRoute[] = [];
  const add = async (from: string, to: string) => {
    const a = places[from], bb = places[to];
    if (!a || !bb || from === to || routes.length >= 24 || routes.some((r) => r.from === from && r.to === to)) return;
    routes.push(await planRoute({ id: `${from}__${to}`, from, to, fromName: a.name, toName: bb.name }, a, bb, saved, budget));
  };
  for (const st of stays) {
    await add(st.airportId, st.hotelId);
    await add(st.hotelId, st.airportId);
    for (const pl of Object.values(places).filter((x) => x.kind === "poi" && x.city === st.city && !x.id.startsWith("city_"))) await add(st.hotelId, pl.id);
  }
  if (Object.keys(saved).length !== Object.keys(p.routeCache ?? {}).length) {
    await db.update(s.travelPlans).set({ extracted: { ...(plan.extracted as object), routeCache: saved } as never, updatedAt: new Date() }).where(eq(s.travelPlans.id, plan.id));
  }

  /* map: reuse our offline street tiles where the city is one of ours, otherwise pins and routes only */
  const destSlugs = cities.map((c) => c.destSlug).filter(Boolean) as string[];
  const destRows = destSlugs.length ? await db.select().from(s.destinations).where(inArray(s.destinations.slug, destSlugs)) : [];
  const { mapCities } = await import("@/lib/packs/build");
  const mapList: PackMapCity[] = cities.map((c) => {
    const row = destRows.find((r) => r.slug === c.destSlug);
    if (row) return { ...mapCities([row])[0], id: c.slug };
    const gen = p.geo.cities[c.slug]?.tiles;
    if (gen) return { id: c.slug, name: c.name, pmtiles: `/api/tiles/${gen.key}.pmtiles`, bytes: gen.bytes, core: null, bbox: gen.bbox, center: [c.lat, c.lon] };
    const pts = Object.values(places).filter((x) => x.city === c.slug);
    const lats = pts.map((x) => x.lat), lons = pts.map((x) => x.lon);
    const bbox: [number, number, number, number] = pts.length ? [Math.min(...lons) - 0.05, Math.min(...lats) - 0.05, Math.max(...lons) + 0.05, Math.max(...lats) + 0.05] : [c.lon - 0.15, c.lat - 0.15, c.lon + 0.15, c.lat + 0.15];
    return { id: c.slug, name: c.name, pmtiles: null, bytes: 0, core: null, bbox, center: [c.lat, c.lon] };
  });

  const firstFlight = flights[0];
  const insurance = (p.contacts ?? []).find((x) => /insur/i.test(x.label));
  const airlineContact = (p.contacts ?? []).find((x) => /air|airline|flight/i.test(x.label));
  return {
    booking: { ref: b.ref, status: "confirmed", pax: b.pax, dates: [b.startDate, b.endDate], totalInr: b.totalInr, title: p.title, origin: p.homeCity ?? cities[0].name, travellers: (p.travellers ?? []).map((t) => t.name) },
    days, places, stays, flights,
    contacts: {
      airline: firstFlight?.carrier ?? "your airline", airline_phone: airlineContact?.phone ?? NOT_GIVEN, insurance_phone: insurance?.phone ?? NOT_GIVEN,
      sms_gateway: process.env.SMS_GATEWAY_NUMBER ?? "+000000000000", emergency: stays[0]?.emergency.general ?? "112",
      hotels: stays.map((st) => ({ city: st.cityName, name: places[st.hotelId].name, phone: places[st.hotelId].phone ?? NOT_GIVEN, address_local: places[st.hotelId].address_local })),
      sample: true,
    },
    routes,
    map: { cities: mapList, style: "/map/style.json", glyphs: "/map/fonts/{fontstack}/{range}.pbf", sprite: "/map/sprites/light" },
    disclaimer: PLAN_DISCLAIMER,
  };
}
