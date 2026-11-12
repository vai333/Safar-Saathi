/**
 * The ONE module that talks to a language model. Model choice, prompt versions, logging and test overrides live here,
 * so they can be swapped and audited in one place. Callers: the trip agent (lib/agent/run.ts) and the rule drafter
 * (lib/rules/generate.ts). Nothing else may import an AI provider.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import { getDb } from "@/lib/db/client";
import * as s from "@/lib/db/schema";

/** Returns null when no key is set: the app then uses the labelled demo agent and template rules. */
export function getModel(): { model: LanguageModel; label: string } | null {
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const name = process.env.LLM_MODEL ?? (provider === "openai" ? "gpt-4.1-mini" : "claude-sonnet-5-5");
  if (provider === "openai") return { model: createOpenAI({ apiKey: key })(name), label: `openai:${name}` };
  if (provider === "openrouter") return { model: createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: key })(name), label: `openrouter:${name}` };
  return { model: createAnthropic({ apiKey: key })(name), label: `anthropic:${name}` };
}

export type LlmRequest = { purpose: "rules" | "agent" | "plan"; promptVersion: string; system: string; prompt: string; /** data: URLs of images the model should read (vision) */ images?: string[]; maxOutputTokens?: number };
type Drafter = (req: LlmRequest) => Promise<string>;
let testDrafter: Drafter | null = null;
/** Tests only: replace the model with a scripted function. */
export function __setLlmDrafter(fn: Drafter | null) { testDrafter = fn; }

export const llmAvailable = () => !!testDrafter || !!getModel();
export const llmLabel = () => (testDrafter ? "test-model" : getModel()?.label ?? "none");

export async function logLlmCall(purpose: string, promptVersion: string, ok: boolean, ms: number, extra: Record<string, unknown> = {}) {
  try {
    const db = await getDb();
    await db.insert(s.events).values({ name: "llm_call", props: { purpose, promptVersion, model: llmLabel(), ok, ms, ...extra } });
  } catch { /* logging must never break a call */ }
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

/** One JSON-returning call (used by the rule drafter). Never throws: returns { ok:false } on any failure. */
export async function llmJson(req: LlmRequest): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    let text: string;
    if (testDrafter) text = await testDrafter(req);
    else {
      const m = getModel();
      if (!m) return { ok: false, error: "No LLM configured" };
      const r = req.images?.length
        ? await generateText({ model: m.model, system: req.system, messages: [{ role: "user", content: [{ type: "text", text: req.prompt }, ...req.images.map((image) => ({ type: "image", image }))] }], temperature: 0.1, maxOutputTokens: req.maxOutputTokens ?? 12000, ...(req.purpose === "rules" ? { abortSignal: AbortSignal.timeout(20000) } : {}) } as never)
        : await generateText({ model: m.model, system: req.system, prompt: req.prompt, temperature: req.purpose === "plan" ? 0.1 : 0.2, maxOutputTokens: req.maxOutputTokens ?? 6000, ...(req.purpose === "rules" ? { abortSignal: AbortSignal.timeout(20000) } : {}) } as never);
      text = (r as { text: string }).text;
    }
    const data = extractJson(text);
    await logLlmCall(req.purpose, req.promptVersion, true, Date.now() - t0);
    return { ok: true, data };
  } catch (e) {
    await logLlmCall(req.purpose, req.promptVersion, false, Date.now() - t0, { error: String(e).slice(0, 160) });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
