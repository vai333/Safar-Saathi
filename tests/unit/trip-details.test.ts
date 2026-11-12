import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { __setLlmDrafter } from "@/lib/llm";
import { processPlan } from "@/lib/plans/process";
import { getLatestPack } from "@/lib/packs/build";
import type { OfflinePack } from "@/lib/packs/types";
import { addTripDetails, DetailsInput } from "@/lib/server/trip-details";
import { addDays } from "@/lib/time";
import { BASE_DATE, setupDb } from "./helpers";

process.env.PLAN_GEOCODER = "off";
process.env.PLAN_ROUTING = "off";
process.env.PLAN_PHOTOS = "off";
process.env.PLAN_TILES = "off";

const start = addDays(BASE_DATE, 20), end = addDays(start, 4);
const PLAN = { title: "Dubai trip, no bookings yet", travellers: [{ name: "Ravi Kumar" }], pax: 1, startDate: start, endDate: end, homeCity: "Mumbai", cities: [{ name: "Dubai", country: "United Arab Emirates", timezone: "Asia/Dubai", from: start, to: end }], flights: [], hotels: [], activities: [], transfers: [], contacts: [], notes: [] };

describe("adding missing flight and hotel details later", () => {
  let c: Awaited<ReturnType<typeof setupDb>>;
  let bookingId = "";
  beforeAll(async () => {
    c = await setupDb();
    __setLlmDrafter(async (req) => { if (req.purpose === "plan") return JSON.stringify(PLAN); throw new Error("rules: use template"); });
    const db = await getDb();
    const [plan] = await db.insert(s.travelPlans).values({ userId: c.neha.id, status: "uploading" }).returning();
    await db.insert(s.planFiles).values({ planId: plan.id, name: "x.txt", mime: "text/plain", kind: "text", bytes: 1, sha256: "q", status: "parsed", text: "Dubai trip" });
    const r = await processPlan(plan.id, c.neha.id);
    if (!r.ok) throw new Error(r.error);
    const [b] = await db.select().from(s.bookings).where(eq(s.bookings.ref, r.ref));
    bookingId = b.id;
  });
  afterAll(() => __setLlmDrafter(null));

  it("starts with no flight and no hotel", async () => {
    const pack = (await getLatestPack(bookingId))!.pack as OfflinePack;
    expect(pack.flights).toHaveLength(0);
    expect(pack.stays.every((st) => pack.places[st.hotelId].kind !== "hotel")).toBe(true);
  });

  it("checks the form input", () => {
    expect(DetailsInput.safeParse({ kind: "flight", airline: "Emirates", flightNo: "ek 501", from: "bom", to: "dxb", departLocal: `${start}T04:30`, arriveLocal: `${start}T06:00` }).success).toBe(true);
    expect(DetailsInput.safeParse({ kind: "flight", airline: "Emirates", flightNo: "EK501", from: "Mumbai", to: "DXB", departLocal: `${start}T04:30`, arriveLocal: `${start}T06:00` }).success).toBe(false);
    expect(DetailsInput.safeParse({ kind: "hotel", name: "Rove", address: "Downtown", city: "Dubai", checkin: "soon", checkout: end }).success).toBe(false);
  });

  it("adds a flight: local times become real instants, the day plan and guide update", async () => {
    const r = await addTripDetails(bookingId, DetailsInput.parse({ kind: "flight", airline: "Emirates", flightNo: "ek 501", from: "bom", to: "dxb", departLocal: `${start}T04:30`, arriveLocal: `${start}T06:00`, pnr: "ABC123" }));
    expect(r.guideUpdated).toBe(true);
    const pack = (await getLatestPack(bookingId))!.pack as OfflinePack;
    expect(pack.flights).toHaveLength(1);
    expect(pack.flights[0]).toMatchObject({ flight_no: "EK501", from: "BOM", to: "DXB", pnr: "ABC123", leg: "outbound" });
    expect(pack.flights[0].depart_at).toBe(new Date(`${start}T04:30:00+05:30`).toISOString());
    expect(pack.days[0].items.some((i) => i.type === "flight")).toBe(true);
    await expect(addTripDetails(bookingId, DetailsInput.parse({ kind: "flight", airline: "Emirates", flightNo: "EK501", from: "BOM", to: "DXB", departLocal: `${start}T04:30`, arriveLocal: `${start}T06:00` }))).rejects.toMatchObject({ status: 409 });
    await expect(addTripDetails(bookingId, DetailsInput.parse({ kind: "flight", airline: "Emirates", flightNo: "EK777", from: "BOM", to: "DXB", departLocal: `${start}T06:00`, arriveLocal: `${start}T04:30` }))).rejects.toMatchObject({ status: 400 });
  });

  it("adds a return flight and relabels the legs", async () => {
    await addTripDetails(bookingId, DetailsInput.parse({ kind: "flight", airline: "Emirates", flightNo: "EK500", from: "DXB", to: "BOM", departLocal: `${end}T22:00`, arriveLocal: `${addDays(end, 1)}T03:00` }));
    const pack = (await getLatestPack(bookingId))!.pack as OfflinePack;
    expect(pack.flights.map((f) => [f.flight_no, f.leg])).toEqual([["EK501", "outbound"], ["EK500", "return"]]);
  });

  it("adds a hotel: it becomes the stay, with a pin, check-in and check-out in the day plan", async () => {
    const r = await addTripDetails(bookingId, DetailsInput.parse({ kind: "hotel", name: "Rove Downtown", address: "Financial Centre Rd, Dubai", city: "Dubai", checkin: start, checkout: addDays(start, 3), phone: "+971 4 000 0000" }));
    expect(r.guideUpdated).toBe(true);
    const pack = (await getLatestPack(bookingId))!.pack as OfflinePack;
    const st = pack.stays.find((x) => pack.places[x.hotelId].kind === "hotel")!;
    expect(pack.places[st.hotelId]).toMatchObject({ name: "Rove Downtown", phone: "+971 4 000 0000" });
    expect(pack.days[0].items.some((i) => i.title === "Check in at Rove Downtown")).toBe(true);
    expect(pack.days[3].items.some((i) => i.title === "Check out of Rove Downtown")).toBe(true);
    expect(st).toMatchObject({ city: "dubai", from: start, to: addDays(start, 3) });
  });

  it("only works for uploaded trips", async () => {
    await expect(addTripDetails(c.booking.id, DetailsInput.parse({ kind: "hotel", name: "Any Hotel", address: "Somewhere 1", city: "Rome", checkin: start, checkout: addDays(start, 1) }))).rejects.toMatchObject({ status: 400 });
  });
});
