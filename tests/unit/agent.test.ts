import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupDb } from "./helpers";
import * as s from "@/lib/db/schema";
import { aiTools, MODEL_TOOLS, runTool, SMS_SAFE_TOOLS, TOOL_NAMES, type ToolCtx, type UiEvent } from "@/lib/agent/tools";
import { demoAgent } from "@/lib/agent/demo";
import { handleInboundSms } from "@/lib/sms/inbound";
import { getLatestPack } from "@/lib/packs/build";

type Ctx = Awaited<ReturnType<typeof setupDb>>;
let c: Ctx;
const events: UiEvent[] = [];
const mk = (over: Partial<ToolCtx> = {}): ToolCtx => ({
  userId: c.neha.id, bookingRef: c.booking.ref, bookingId: c.booking.id, threadId: null, channel: "app", now: new Date(), ui: (e) => events.push(e), ...over,
});
const emit = { step: () => {}, text: () => {} };

beforeAll(async () => { c = await setupDb(); });

describe("agent tools", () => {
  it("registers 14 tools; the model gets 11 (refresh_offline_pack is server-only, search_flights and search_stays are mock-only) and none can mint a token", () => {
    expect(TOOL_NAMES).toEqual(["get_itinerary", "get_route", "search_flights", "connect_platform", "compare_flights", "compare_hotels", "search_stays", "search_web", "add_trip_details", "quote_change", "apply_change", "refresh_offline_pack", "escalate_human", "send_sms"]);
    expect(Object.keys(aiTools(mk())).sort()).toEqual([...MODEL_TOOLS].sort());
    expect(Object.keys(aiTools(mk()))).not.toContain("refresh_offline_pack");
    expect(Object.keys(aiTools(mk()))).not.toContain("search_flights"); // flight changes never use sample inventory in chat
    expect(Object.keys(aiTools(mk()))).toContain("connect_platform");
    expect(Object.keys(aiTools(mk()))).toContain("compare_flights");
    expect(Object.keys(aiTools(mk()))).toContain("add_trip_details");
    expect(Object.keys(aiTools(mk(), SMS_SAFE_TOOLS))).not.toContain("add_trip_details"); // a form needs the app, not SMS
    expect(SMS_SAFE_TOOLS.every((t) => TOOL_NAMES.includes(t))).toBe(true);
    expect(Object.keys(aiTools(mk(), SMS_SAFE_TOOLS)).length).toBe(3);
  });

  it("every call is written to tool_calls (the action log)", async () => {
    const before = (await c.db.select().from(s.toolCalls)).length;
    const out = (await runTool("get_itinerary", {}, mk())) as { currentCity: string; flights: { itemId: string }[] };
    expect(out.currentCity).toBe("Paris");
    expect(out.flights.length).toBe(3);
    expect((await c.db.select().from(s.toolCalls)).length).toBe(before + 1);
  });

  it("apply_change without a confirmation token does nothing and is logged as blocked", async () => {
    const itin = (await runTool("get_itinerary", {}, mk())) as { flights: { itemId: string; leg: string }[] };
    const inter = itin.flights.find((f) => f.leg === "intercity")!;
    const search = (await runTool("search_flights", { itemId: inter.itemId }, mk())) as { alternatives: { flightId: string }[] };
    const q = (await runTool("quote_change", { kind: "flight_change", itemId: inter.itemId, newFlightId: search.alternatives[0].flightId }, mk())) as { options: { quoteId: string }[] };
    const [before] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, c.booking.id));
    const r = (await runTool("apply_change", { quoteId: q.options[0].quoteId }, mk())) as unknown as { applied: boolean; error: string };
    expect(r.applied).toBe(false);
    expect(r.error).toBe("CONFIRMATION_REQUIRED");
    const [after] = await c.db.select().from(s.bookings).where(eq(s.bookings.id, c.booking.id));
    expect(after.totalInr).toBe(before.totalInr);
    expect(after.packVersion).toBe(before.packVersion);
    const blocked = await c.db.select().from(s.toolCalls).where(eq(s.toolCalls.status, "blocked"));
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("the model cannot call refresh_offline_pack; the server can", async () => {
    await expect(runTool("refresh_offline_pack", {}, mk())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = (await runTool("refresh_offline_pack", {}, mk(), { internal: true })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it("search_web says so plainly when no search API is configured and never returns a price", async () => {
    delete process.env.TAVILY_API_KEY; delete process.env.BRAVE_API_KEY;
    const r = (await runTool("search_web", { query: "visa rules for Schengen" }, mk())) as { configured: boolean; note: string; results: unknown[] };
    expect(r.configured).toBe(false);
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/not configured/i);
  });

  it("quote_change builds one option per alternative (up to 3), each with its own quote and breakup", async () => {
    const itin = (await runTool("get_itinerary", {}, mk())) as { flights: { itemId: string; leg: string }[] };
    const f = itin.flights.find((x) => x.leg === "return")!;
    const search = (await runTool("search_flights", { itemId: f.itemId }, mk())) as { alternatives: { flightId: string }[]; liveOffers: unknown[]; source: string };
    expect(search.source).toBe("Sample data (mock API)");
    expect(search.liveOffers).toEqual([]); // no real provider key: mock only
    const ids = search.alternatives.slice(0, 3).map((a) => a.flightId);
    const q = (await runTool("quote_change", { kind: "flight_change", itemId: f.itemId, newFlightIds: ids }, mk())) as { options: { quoteId: string; breakup: { amountInr: number }[]; totalInr: number }[] };
    expect(q.options.length).toBe(ids.length);
    expect(new Set(q.options.map((o) => o.quoteId)).size).toBe(ids.length);
    for (const o of q.options) expect(o.breakup.reduce((a, l) => a + l.amountInr, 0)).toBe(o.totalInr);
  });

  it("rejects malformed tool input", async () => {
    await expect(runTool("search_stays", { extraNights: 99 }, mk())).rejects.toThrow();
  });

  it("escalate_human takes the more severe of rubric and model, and never lets the agent close the case", async () => {
    const r = (await runTool("escalate_human", { summary: "lost passport in Rome", severity: 3 }, mk())) as { severity: number; agentMayCloseCase: boolean; caseRef: string };
    expect(r.severity).toBe(1);
    expect(r.agentMayCloseCase).toBe(false);
    expect(r.caseRef).toMatch(/^SS-C-\d+$/);
  });
});

describe("demo agent (STUB used when no LLM key is set)", () => {
  it("answers the pickup question from the booking", async () => {
    const t = await demoAgent("When is my pickup?", mk(), emit);
    expect(t).toMatch(/Your pickup in Paris/);
    expect(t).toMatch(/code SS\d{4}/);
  });

  it("flight change: compares SAMPLE fares from the mock partner API (labelled), per platform, no review card, never says it is done", async () => {
    events.length = 0;
    const t = await demoAgent("Please move my Paris to Rome flight later", mk(), emit);
    expect(events.some((e) => e.t === "review")).toBe(false);
    const cmp = events.find((e) => e.t === "compare") as Extract<UiEvent, { t: "compare" }>;
    expect(cmp).toBeTruthy();
    expect(cmp.sample).toBe(true);
    expect(cmp.offers.length).toBeGreaterThan(0);
    for (const o of cmp.offers) {
      expect(o.source).toMatch(/Sample fares from the Safar Saathi mock partner API, not live prices/);
      expect(o.platformPrices!.map((p) => p.platform).sort()).toEqual(["cleartrip", "goibibo", "ixigo", "makemytrip"]);
    }
    expect(cmp.platforms.map((p) => p.name)).toEqual(["MakeMyTrip", "Goibibo", "Cleartrip", "ixigo"]);
    for (const p of cmp.platforms) expect(p.searchUrl).toMatch(/^https:\/\//);
    expect(t).toMatch(/sample fares/i);
    expect(t).toMatch(/not live prices/);
    expect(t).toMatch(/cannot log in there for you/);
    expect(t).toMatch(/never see your password/);
    expect(t).not.toMatch(/done|confirmed|booked it/i);
  });

  it("the model cannot quote a flight change from sample data", async () => {
    const tools = aiTools(mk()) as Record<string, { execute: (i: unknown) => Promise<{ error?: string }> }>;
    const out = await tools.quote_change.execute({ kind: "flight_change", itemId: "00000000-0000-4000-8000-000000000000", newFlightId: "00000000-0000-4000-8000-000000000001" });
    expect(out.error).toBe("USE_PLATFORM");
  });

  it("a lost passport escalates at once as severity 1", async () => {
    events.length = 0;
    const t = await demoAgent("I lost my passport!", mk(), emit);
    const ev = events.find((e) => e.t === "case") as Extract<UiEvent, { t: "case" }>;
    expect(ev.severity).toBe(1);
    expect(t).toMatch(/cannot close this case/);
  });

  it("a stay change compares SAMPLE hotel prices (labelled, per platform), no review card, never says it is done", async () => {
    events.length = 0;
    const t = await demoAgent("Extend my stay by 1 night", mk(), emit);
    expect(events.some((e) => e.t === "review")).toBe(false);
    const h = events.find((e) => e.t === "hotels") as Extract<UiEvent, { t: "hotels" }>;
    expect(h).toBeTruthy();
    expect(h.configured).toBe(true);
    expect(h.sample).toBe(true);
    expect(h.offers.length).toBeGreaterThan(0);
    expect(h.offers[0].platformPrices!.length).toBe(4);
    expect(h.platforms.map((p) => p.name)).toEqual(["MakeMyTrip", "Goibibo", "Cleartrip", "ixigo"]);
    expect(h.query.nights).toBe(1);
    expect(t).toMatch(/sample hotel prices/i);
    expect(t).toMatch(/not live prices/);
    expect(t).toMatch(/never see your password/);
  });

  it("the model cannot quote a stay extension from sample data", async () => {
    const tools = aiTools(mk()) as Record<string, { execute: (i: unknown) => Promise<{ error?: string }> }>;
    expect((await tools.quote_change.execute({ kind: "hotel_extend", extraNights: 1 })).error).toBe("USE_PLATFORM");
    expect(Object.keys(tools)).not.toContain("search_stays");
    expect(Object.keys(tools)).toContain("compare_hotels");
  });
});

describe("SMS fallback", () => {
  it("'SOS lost passport SS-48213' opens a severity-1 case and replies with the case ID in 160 chars", async () => {
    const r = await handleInboundSms({ from: "+919800000001", body: "SOS lost passport SS-48213", messageId: "t-1" }, c.db);
    expect(r.reply).toMatch(/^Severity 1\. Human paged\. Case ID SS-C-\d+\.$/);
    expect(r.reply.length).toBeLessThanOrEqual(160);
    const cases = await c.db.select().from(s.cases).where(eq(s.cases.caseRef, r.caseRef!));
    expect(cases[0].severity).toBe(1);
    expect(cases[0].channel).toBe("sms");
  });

  it("is idempotent by message id, and stores only a masked sender", async () => {
    const before = (await c.db.select().from(s.cases)).length;
    const again = await handleInboundSms({ from: "+919800000001", body: "SOS lost passport SS-48213", messageId: "t-1" }, c.db);
    expect(again.duplicate).toBe(true);
    expect((await c.db.select().from(s.cases)).length).toBe(before);
    const msgs = await c.db.select().from(s.smsMessages);
    expect(msgs.every((m) => !m.fromMasked.includes("98000000"))).toBe(true);
  });

  it("matches a sender by phone and answers read-only questions from the saved pack", async () => {
    const r = await handleInboundSms({ from: "+919800000001", body: "Where is my pickup?", messageId: "t-2" }, c.db);
    expect(r.reply).toMatch(/Pickup:/);
    const row = await getLatestPack(c.booking.id);
    expect(row).toBeTruthy();
  });

  it("asks for a booking ref when the sender is unknown", async () => {
    const r = await handleInboundSms({ from: "+10000000000", body: "help", messageId: "t-3" }, c.db);
    expect(r.reply).toMatch(/booking ref/);
  });
});
