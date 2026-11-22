// The AI agent: a manual tool loop over the Claude Messages API. Claude chooses the tools;
// this code runs them (billing API through the gateway, docs through MCP), returns the
// results, and repeats until Claude answers. Writes pause for the user's confirmation.
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { BillingApiClient } from "./billingApiClient";
import type { McpTools } from "./mcpClient";
import { SYSTEM_PROMPT, dateNote } from "./prompt";
import { BILLING_TOOLS, WRITE_TOOLS, confirmationText, runBillingTool, type Session } from "./tools";

// Only what the agent needs from the SDK client, so tests can pass a scripted fake.
export interface ModelClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface TraceEntry {
  tool: string;
  input: unknown;
  result: string;
  isError: boolean;
  confirmed?: boolean; // writes only: did the user approve?
}

// Tokens used by the model calls of the current turn (shown in the trace, for cost notes).
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  modelCalls: number;
}

export type TurnResult =
  | { kind: "answer"; text: string; trace: TraceEntry[]; usage: Usage }
  | { kind: "confirm"; confirmationId: string; summary: string; trace: TraceEntry[]; usage: Usage };

// Where a turn stopped to wait for the user: the tool calls of one assistant message,
// how far through them we got, and the results so far (sent back together, in one
// message, once all of them are done).
interface Pending {
  confirmationId: string;
  toolUses: Anthropic.ToolUseBlock[];
  index: number;
  results: Anthropic.ToolResultBlockParam[];
}

export interface Conversation {
  id: string;
  session: Session;
  messages: Anthropic.MessageParam[];
  pending?: Pending | undefined; // set while waiting for the user to confirm a write
  trace: TraceEntry[]; // of the current turn
  usage: Usage; // of the current turn
  declined: boolean; // the user declined a write in the current turn: no more writes until the next message
}

const MAX_MODEL_CALLS = 8; // per user message: a stuck loop stops instead of burning tokens
const RESULT_PREVIEW = 600;

export interface AgentDeps {
  model: ModelClient;
  modelName: string;
  api: BillingApiClient;
  mcp: McpTools;
  now?: () => Date;
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  newConversation(session: Session): Conversation {
    return { id: randomUUID(), session, messages: [], trace: [], usage: noUsage(), declined: false };
  }

  async ask(conv: Conversation, text: string): Promise<TurnResult> {
    if (conv.pending) throw new Error("Answer the pending confirmation first");
    conv.trace = [];
    conv.usage = noUsage();
    conv.declined = false;
    conv.messages.push({ role: "user", content: text });
    return this.loop(conv);
  }

  async confirm(conv: Conversation, confirmationId: string, approve: boolean): Promise<TurnResult> {
    const pending = conv.pending;
    if (!pending || pending.confirmationId !== confirmationId) throw new Error("No such confirmation");
    const toolUse = pending.toolUses[pending.index]!;
    conv.pending = undefined;

    if (approve) {
      const out = await this.runTool(conv, toolUse);
      conv.trace.push({ tool: toolUse.name, input: toolUse.input, result: preview(out.text), isError: out.isError, confirmed: true });
      pending.results.push(toolResult(toolUse.id, out.text, out.isError));
    } else {
      conv.declined = true;
      conv.trace.push({ tool: toolUse.name, input: toolUse.input, result: "declined by the user", isError: true, confirmed: false });
      pending.results.push(toolResult(toolUse.id, "The user declined this action. It was not performed.", true));
    }
    const paused = await this.runTools(conv, { ...pending, index: pending.index + 1 });
    return paused ?? this.loop(conv);
  }

  // Calls Claude until it answers (or asks for a confirmation).
  private async loop(conv: Conversation): Promise<TurnResult> {
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      const response = await this.deps.model.messages.create({
        model: this.deps.modelName,
        max_tokens: 16000,
        output_config: { effort: "medium" }, // Haiku 5.5's default, set explicitly
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, // tools + rules: cached
          { type: "text", text: dateNote((this.deps.now ?? (() => new Date()))()) },
        ],
        tools: [...this.deps.mcp.tools, ...BILLING_TOOLS],
        messages: conv.messages,
      });
      conv.usage.modelCalls++;
      conv.usage.inputTokens += response.usage?.input_tokens ?? 0;
      conv.usage.outputTokens += response.usage?.output_tokens ?? 0;
      conv.usage.cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const runsTools = response.stop_reason === "tool_use" && toolUses.length > 0;
      // The whole content (thinking blocks included) goes back unchanged next time, except
      // tool calls that won't run (a reply cut off at max_tokens, or a refusal): the API
      // refuses a history with a tool call that has no result, so keeping one would break
      // every later message of this conversation.
      const kept = runsTools ? response.content : response.content.filter((b) => b.type !== "tool_use");
      if (kept.length > 0) conv.messages.push({ role: "assistant", content: kept });

      if (response.stop_reason === "refusal") {
        return this.answer(conv, "I can't help with that request.");
      }
      if (!runsTools) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (response.stop_reason === "max_tokens") {
          return this.answer(conv, text ? `${text}\n\n(The answer was cut off.)` : "Sorry, that answer got too long. Please ask a narrower question.");
        }
        return this.answer(conv, text || "(no answer)");
      }
      const paused = await this.runTools(conv, { confirmationId: "", toolUses, index: 0, results: [] });
      if (paused) return paused;
    }
    return this.answer(conv, "Sorry, I couldn't finish that. Please try asking in a simpler way.");
  }

  // Runs the remaining tool calls of one assistant message. Stops at a write tool to ask
  // the user; otherwise sends all results back in a single user message.
  private async runTools(conv: Conversation, state: Pending): Promise<TurnResult | undefined> {
    for (let i = state.index; i < state.toolUses.length; i++) {
      const toolUse = state.toolUses[i]!;
      if (WRITE_TOOLS.has(toolUse.name) && conv.declined) {
        // Enforced here, not only in the prompt: a declined user isn't asked again this turn.
        const why = "The user already declined an action in this message. It was not performed and won't be asked again; tell the user.";
        conv.trace.push({ tool: toolUse.name, input: toolUse.input, result: "not asked: the user declined earlier in this message", isError: true, confirmed: false });
        state.results.push(toolResult(toolUse.id, why, true));
        continue;
      }
      if (WRITE_TOOLS.has(toolUse.name)) {
        let summary: string;
        try {
          summary = confirmationText(toolUse.name, toolUse.input, conv.session);
        } catch {
          state.results.push(toolResult(toolUse.id, "Invalid input for this action.", true));
          continue;
        }
        const confirmationId = randomUUID();
        conv.pending = { ...state, confirmationId, index: i };
        return { kind: "confirm", confirmationId, summary, trace: conv.trace, usage: conv.usage };
      }
      const out = await this.runTool(conv, toolUse);
      conv.trace.push({ tool: toolUse.name, input: toolUse.input, result: preview(out.text), isError: out.isError });
      state.results.push(toolResult(toolUse.id, out.text, out.isError));
    }
    conv.messages.push({ role: "user", content: state.results });
    return undefined;
  }

  private async runTool(conv: Conversation, toolUse: Anthropic.ToolUseBlock): Promise<{ text: string; isError: boolean }> {
    try {
      if (this.deps.mcp.tools.some((t) => t.name === toolUse.name)) {
        return await this.deps.mcp.call(toolUse.name, toolUse.input as Record<string, unknown>);
      }
      return await runBillingTool(this.deps.api, conv.session, toolUse.name, toolUse.input);
    } catch (err) {
      // A failed tool goes back to Claude as an error result, never dropped.
      return { text: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private answer(conv: Conversation, text: string): TurnResult {
    return { kind: "answer", text, trace: conv.trace, usage: conv.usage };
  }
}

function noUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
}

function toolResult(id: string, text: string, isError: boolean): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) };
}

function preview(text: string): string {
  return text.length > RESULT_PREVIEW ? `${text.slice(0, RESULT_PREVIEW)}…` : text;
}
