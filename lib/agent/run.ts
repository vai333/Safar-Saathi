/* eslint-disable @typescript-eslint/no-explicit-any */
import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from "ai";
import { demoAgent } from "./demo";
import { getModel, logLlmCall } from "@/lib/llm";
import { systemPrompt } from "./prompt";
import { scopeRefusal } from "./scope";
import { aiTools, SMS_SAFE_TOOLS, type ToolCtx, type UiEvent } from "./tools";
import { getItinerary } from "./tools";

export type AgentEvent =
  | { t: "step"; id: string; name: string; status: "running" | "done" | "error" }
  | { t: "text"; delta: string }
  | UiEvent;

export type RunResult = { text: string; agent: "llm" | "demo"; label: string };

/** Runs the trip agent. LLM when LLM_API_KEY is set, otherwise the labelled demo agent. */
export async function runAgent(opts: { ctx: ToolCtx; history: ModelMessage[]; message: string; emit: (e: AgentEvent) => void; modelOverride?: LanguageModel }): Promise<RunResult> {
  const { ctx, history, message, emit } = opts;
  // Topic guard: clearly off-topic or rule-override messages never reach the model.
  const refusal = scopeRefusal(message);
  if (refusal) {
    for (const part of refusal.match(/.{1,24}(\s|$)/g) ?? [refusal]) emit({ t: "text", delta: part });
    return { text: refusal, agent: "llm", label: "Travel-only guard" };
  }
  const chosen = opts.modelOverride ? { model: opts.modelOverride, label: "test-model" } : getModel();
  let n = 0;
  ctx.ui = ((orig) => (e: UiEvent) => { orig(e); emit(e); })(ctx.ui);

  if (!chosen) {
    const ids: string[] = [];
    const text = await demoAgent(message, ctx, {
      step: (name, status) => {
        if (status === "running") ids.push(`${name}-${++n}`);
        emit({ t: "step", id: ids[ids.length - 1], name, status });
      },
      text: () => {},
    });
    const out = ctx.channel === "sms" ? text.slice(0, 160) : text;
    // stream the demo text in small chunks so the UI behaves like the real stream
    for (const part of out.match(/.{1,24}(\s|$)/g) ?? [out]) {
      emit({ t: "text", delta: part });
      await new Promise((r) => setTimeout(r, 12));
    }
    return { text: out, agent: "demo", label: "Demo agent (no LLM key)" };
  }

  const it = (await getItinerary(ctx).catch(() => null)) as { today: string; travellerLocalTime: string; currentCity: string } | null;
  const result = streamText({
    model: chosen.model,
    system: systemPrompt({ today: it?.today ?? ctx.now.toISOString().slice(0, 10), localTime: it?.travellerLocalTime ?? "unknown", city: it?.currentCity ?? "unknown", bookingRef: ctx.bookingRef, channel: ctx.channel }),
    messages: [...history, { role: "user", content: message }],
    tools: aiTools(ctx, ctx.channel === "sms" ? SMS_SAFE_TOOLS : undefined) as never,
    stopWhen: stepCountIs(8),
    maxOutputTokens: ctx.channel === "sms" ? 120 : 900,
    temperature: 0.2,
  } as any) as unknown as { fullStream: AsyncIterable<any> };
  let text = "";
  const t0 = Date.now();
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
      emit({ t: "text", delta: part.text });
    } else if (part.type === "tool-call") {
      emit({ t: "step", id: part.toolCallId, name: part.toolName, status: "running" });
    } else if (part.type === "tool-result") {
      const out = part.output as { error?: string } | undefined;
      emit({ t: "step", id: part.toolCallId, name: part.toolName, status: out && typeof out === "object" && "error" in out ? "error" : "done" });
    } else if (part.type === "tool-error") {
      emit({ t: "step", id: part.toolCallId, name: part.toolName, status: "error" });
    } else if (part.type === "error") {
      await logLlmCall("agent", "agent-v1", false, Date.now() - t0);
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
  await logLlmCall("agent", "agent-v1", true, Date.now() - t0);
  return { text, agent: "llm", label: chosen.label };
}
