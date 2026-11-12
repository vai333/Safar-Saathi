import { createHash } from "node:crypto";
import { llmAvailable, llmJson, llmLabel } from "@/lib/llm";
import { stableStringify } from "@/lib/packs/hash";
import { buildContext } from "./context";
import type { Scenario as EngineScenario } from "./engine";
import { RULES_PROMPT_VERSION, RULES_SCHEMA_VERSION, ScenarioSchema, toEngineScenarios, type RuleSetIn, type ScenarioIn } from "./schema";
import { SCENARIO_ORDER, TEMPLATE_RULES, type ScenarioId } from "./scenarios";
import { validateRuleSet, type Check, type RuleData } from "./validate";

export type RulesMeta = {
  origin: "llm" | "template" | "mixed";
  /** The honest label shown above the guide. */
  label: string;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  generatedAt: string;
  sourceHash: string;
  deps: Record<string, string>;
  scenarioOrigin: Record<string, "llm" | "template">;
  /** Scenarios (re)drafted in this run. Empty when nothing changed. */
  regenerated: string[];
  failures: string[];
};
export type StoredRules = { ruleSet: RuleSetIn; meta: RulesMeta };
export type RulesResult = { stored: StoredRules; engine: Record<string, EngineScenario>; checks: Check[]; regenerated: string[] };

export const LABEL_LLM = "Guide generated for this trip. Checked against your booking.";
export const LABEL_TEMPLATE = "Standard guide, not personalised yet";
export const LABEL_MIXED = "Partly generated for this trip, partly standard. Checked against your booking.";

const sha = (x: unknown) => `sha256:${createHash("sha256").update(stableStringify(x)).digest("hex")}`;

/**
 * What each scenario is *about*. Text uses {{references}}, so changed values flow through automatically; a scenario only
 * needs redrafting when the facts it is built on change. (Hotel change => hotel scenario; flight change => the two flight scenarios.)
 */
export function scenarioDeps(d: RuleData): Record<ScenarioId, string> {
  const flights = d.flights.map((f) => [f.leg, f.flight_no, f.from, f.to, f.carrier]);
  const hotels = Object.values(d.places).filter((p) => p.kind === "hotel").map((p) => [p.id, p.name, p.address, p.address_local, p.phone]);
  const drivers = d.stays.map((s) => [s.city, s.driver.name, s.driver.vendor, s.driver.pickup_code]);
  const emerg = d.stays.map((s) => [s.city, s.emergency]);
  const consul = d.stays.map((s) => [s.city, s.consulate]);
  return {
    "flight-delayed": sha({ flights, airline: d.contacts.airline_phone }),
    "missed-connection": sha({ flights, airline: d.contacts.airline_phone }),
    "hotel-not-found": sha({ hotels }),
    "transfer-no-show": sha({ drivers }),
    "lost-passport": sha({ consul, emerg }),
    "medical-help": sha({ emerg, ins: d.contacts.insurance_phone }),
  };
}

export function templateScenario(id: ScenarioId): ScenarioIn {
  return ScenarioSchema.parse(TEMPLATE_RULES[id]);
}

function describeRefs(d: RuleData): string {
  const ctx = buildContext(d as never, new Date(`${d.stays[0].from}T12:00:00Z`), d.stays[0].city);
  const lines: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    else if (typeof v === "string" || typeof v === "number") lines.push(`${p} = ${String(v).slice(0, 60)}`);
  };
  walk((ctx as { current: unknown }).current, "current"); walk(d.contacts, "contacts"); walk({ ref: d.booking.ref }, "booking");
  return lines.slice(0, 90).join("\n");
}

const SYSTEM = `You write offline emergency guides for first-time travellers. You output ONLY JSON.
Hard rules:
- Never write a phone number, address, time, price or flight number as literal text. Use {{path}} references from the allowed list, or an "action" with a "ref".
- Show addresses only via refs ending in address_local.
- Each step: plain English, at most 20 words, no questions, no instruction to pay, cancel or sign anything.
- Keep the scenario ids, severity, sos flags and "fallback": "sos". Medical and lost-passport must reference current.emergency / current.consulate.
- Unknown fields are rejected. Return {"scenarios":[...]} matching the baseline structure.`;

async function draftWithLlm(ids: ScenarioId[], d: RuleData, errors: string[]): Promise<{ ok: true; scenarios: ScenarioIn[] } | { ok: false; error: string }> {
  const prompt = JSON.stringify({
    task: "Personalise these scenarios for this trip. Improve ordering and wording, keep every reference valid.",
    scenarioIds: ids,
    baseline: ids.map((i) => TEMPLATE_RULES[i]),
    allowedRefs: describeRefs(d),
    previousValidationErrors: errors,
  });
  const r = await llmJson({ purpose: "rules", promptVersion: RULES_PROMPT_VERSION, system: SYSTEM, prompt });
  if (!r.ok) return r;
  const arr = (r.data as { scenarios?: unknown[] })?.scenarios;
  if (!Array.isArray(arr)) return { ok: false, error: "Response has no scenarios array" };
  const out: ScenarioIn[] = [];
  for (const raw of arr) {
    const p = ScenarioSchema.safeParse(raw);
    if (!p.success) return { ok: false, error: `Scenario failed schema: ${p.error.issues[0]?.path.join(".")} ${p.error.issues[0]?.message}` };
    if (ids.includes(p.data.id)) out.push(p.data);
  }
  if (out.length !== ids.length) return { ok: false, error: "Response is missing requested scenarios" };
  return { ok: true, scenarios: out };
}

function assemble(tripId: string, scenarios: Map<ScenarioId, ScenarioIn>, sourceHash: string, model: string): RuleSetIn {
  return {
    schemaVersion: RULES_SCHEMA_VERSION, tripId, generatedBy: { model, promptVersion: RULES_PROMPT_VERSION, at: new Date().toISOString() },
    scenarios: SCENARIO_ORDER.map((i) => scenarios.get(i)!), sourceHash,
  };
}

/**
 * Build (or partially rebuild) the validated rule set for a trip.
 * 1. Scenarios whose facts did not change keep their stored text.
 * 2. Changed ones are drafted once by the LLM, validated, retried once with the errors, then fall back to the template.
 * 3. A rule set is only returned if it passes every validator. The result is frozen: nothing edits it afterwards.
 */
export async function resolveRules(data: RuleData, tripId: string, prev?: StoredRules | null): Promise<RulesResult> {
  const deps = scenarioDeps(data);
  const sourceHash = sha(deps);
  const keep = new Map<ScenarioId, ScenarioIn>();
  const origin: Record<string, "llm" | "template"> = {};
  const changed: ScenarioId[] = [];
  for (const id of SCENARIO_ORDER) {
    const old = prev?.ruleSet.scenarios.find((s) => s.id === id);
    if (prev && old && prev.meta.deps[id] === deps[id]) { keep.set(id, old); origin[id] = prev.meta.scenarioOrigin[id] ?? "template"; }
    else changed.push(id);
  }
  if (!changed.length && prev) {
    // nothing this trip's rules are built on has changed: keep the frozen set byte-for-byte (no new version)
    return { stored: prev, engine: toEngineScenarios(prev.ruleSet), checks: [], regenerated: [] };
  }
  const failures: string[] = [];
  const model = llmAvailable() ? llmLabel() : "none";

  if (changed.length) {
    let drafted: ScenarioIn[] | null = null;
    if (llmAvailable()) {
      let errors: string[] = [];
      const started = Date.now();
      for (let attempt = 0; attempt < 2 && !drafted; attempt++) {
        if (attempt > 0 && Date.now() - started > 25000) { failures.push("retry skipped: out of time"); break; } // the request has a hard limit; templates are the safe fallback
        const r = await draftWithLlm(changed, data, errors);
        if (!r.ok) { errors = [r.error]; failures.push(`attempt ${attempt + 1}: ${r.error}`); continue; }
        const trial = new Map(keep);
        r.scenarios.forEach((s) => trial.set(s.id, s));
        // templates fill any gap so the whole set can be checked
        for (const id of SCENARIO_ORDER) if (!trial.has(id)) trial.set(id, templateScenario(id));
        const v = validateRuleSet(assemble(tripId, trial, sourceHash, model), data);
        if (v.ok) drafted = r.scenarios;
        else { errors = v.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`); failures.push(`attempt ${attempt + 1}: ${errors.join(" | ").slice(0, 200)}`); }
      }
    } else failures.push("No LLM configured");
    for (const id of changed) {
      const d = drafted?.find((s) => s.id === id);
      keep.set(id, d ?? templateScenario(id));
      origin[id] = d ? "llm" : "template";
    }
  }

  const ruleSet = assemble(tripId, keep, sourceHash, model);
  const v = validateRuleSet(ruleSet, data);
  if (!v.ok) {
    // Cannot happen with the shipped templates (a test guards this). Never store an invalid rule set.
    throw new Error(`Rule set failed validation: ${v.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`).join("; ")}`);
  }
  const vals = Object.values(origin);
  const kind = vals.every((o) => o === "llm") ? "llm" : vals.every((o) => o === "template") ? "template" : "mixed";
  const meta: RulesMeta = {
    origin: kind, label: kind === "llm" ? LABEL_LLM : kind === "template" ? LABEL_TEMPLATE : LABEL_MIXED, model, promptVersion: RULES_PROMPT_VERSION,
    schemaVersion: RULES_SCHEMA_VERSION, generatedAt: new Date().toISOString(), sourceHash, deps, scenarioOrigin: origin, regenerated: changed, failures,
  };
  return { stored: { ruleSet: v.ruleSet!, meta }, engine: toEngineScenarios(v.ruleSet!), checks: v.checks, regenerated: changed };
}
