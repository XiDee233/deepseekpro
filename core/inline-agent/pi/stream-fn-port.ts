/**
 * StreamFn port for the pi-agent-core integration (Issue A1).
 *
 * Contract module: declares the serializable seam between the pi agent loop
 * and the DeepSeek web backend. It MUST NOT import concrete browser, DOM,
 * provider, or entrypoint implementations (AGENTS.md contract rule); only
 * pure types from pi packages and core type modules are allowed.
 *
 * The port has four parts:
 *  1. `DeepSeekTurnRequest/Callbacks/Result` — one DS-web turn, serializable.
 *  2. `DeepSeekTurnSubmitter` — the injection point satisfied by a thin
 *     wrapper around `submitPromptStreaming` (A1-T2).
 *  3. `DeepSeekSessionState` — the DS conversation-chain authority owned by
 *     the loop adapter (A3). The page session, never the pi context, is the
 *     source of truth for `parentMessageId` (fail-closed against chain forks).
 *  4. `DeepSeekStreamFnFactory` — the pi `StreamFn` factory (A1-T2).
 *
 * Version-drift guard: `tests/stream-fn-port.test.ts` asserts assignability
 * against the exact pi export shapes, so an upstream API break fails
 * compilation instead of surfacing at runtime.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Context, ToolCall } from '@earendil-works/pi-ai';
import type { ToolDescriptor } from '../../types';
import type { ResponseTokenSpeedPayload } from '../../deepseek/stream-metrics';
import type { AgentDiagnosticSink } from '../../diagnostics/agent-contract';

/** One DS-web turn request — the serializable wire contract. */
export interface DeepSeekTurnRequest {
  chatSessionId: string;
  parentMessageId: number | null;
  modelType: string | null;
  prompt: string;
  refFileIds: string[];
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

/** Callbacks invoked while the DS-web turn streams. */
export interface DeepSeekTurnCallbacks {
  onTextChunk: (text: string, fullText: string) => void;
  /** Reasoning/thinking deltas of the current turn (THINK fragments). */
  onReasoningChunk?: (reasoning: string, fullReasoning: string) => void;
  onTokenSpeed: (progress: ResponseTokenSpeedPayload) => void;
}

/** Result of one completed DS-web turn. */
export interface DeepSeekTurnResult {
  assistantText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
}

/**
 * The model-backend seam: submits one DS-web turn and resolves with its
 * result. Satisfied by a thin wrapper around `submitPromptStreaming`
 * (same callbacks, same no-chunk-retry / abort semantics).
 */
export type DeepSeekTurnSubmitter = (
  request: DeepSeekTurnRequest,
  callbacks: DeepSeekTurnCallbacks,
  signal?: AbortSignal,
) => Promise<DeepSeekTurnResult>;

/**
 * DS conversation-chain state owned by the loop adapter (A3).
 *
 * The page session is the authority: the pi context is only the current-turn
 * working memory (risk (g) mitigation). `setParentMessageId` is called with
 * every successful turn result; a `null` response id fails closed (tool calls
 * are refused without a continuable chain link).
 */
export interface DeepSeekSessionState {
  chatSessionId: string;
  parentMessageId: number | null;
  setParentMessageId: (id: number | null) => void;
}

/**
 * Serializes the pi request context (system prompt + message transcript) into
 * the DS-web wire prompt. Pure function; must not throw.
 *
 * The inline-agent wire contract (`<original_task>`/`<tool_results>`/
 * `<task_complete>` markers, truncation suffixes, invisible placeholders) is
 * preserved by this serializer — pi's own prompt templates are never used
 * (prompt-bytes invariant, AGENTS.md).
 */
export type DeepSeekPromptSerializer = (context: Context) => string;

/** Parsed XML tool call shape produced by the DS stream parser. */
export interface ParsedXmlToolCall {
  name: string;
  invocationName: string;
  payload: Record<string, unknown>;
}

/**
 * Maps one parsed XML tool call (from the DS text stream) to the pi ToolCall
 * shape. `index` is the zero-based position within the turn, used to
 * synthesize the required stable `id` when the XML block carries none.
 */
export type DeepSeekToolCallMapper = (call: ParsedXmlToolCall, index: number) => ToolCall;

/** Per-run DS-web turn defaults (from the loop adapter's prompt options). */
export interface DeepSeekTurnDefaults {
  modelType: string | null;
  refFileIds: string[];
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

/** Dependencies required to build the DS-web StreamFn (A1-T2). */
export interface DeepSeekStreamFnDeps {
  submitTurn: DeepSeekTurnSubmitter;
  session: DeepSeekSessionState;
  serializePrompt: DeepSeekPromptSerializer;
  mapToolCall: DeepSeekToolCallMapper;
  /** Tool descriptors used to parse XML tool calls out of the DS text stream. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Per-run defaults merged into every turn request. */
  turnDefaults: DeepSeekTurnDefaults;
  /**
   * Optional forwarder for DS-web token-speed progress. The loop adapter
   * (A3) wires this to the `AGENT_TOKEN_SPEED` page event.
   */
  onTokenSpeed?: (progress: ResponseTokenSpeedPayload) => void;
  onDiagnostic?: AgentDiagnosticSink;
}

/** The pi StreamFn factory implemented by the DS-web adapter. */
export type DeepSeekStreamFnFactory = (deps: DeepSeekStreamFnDeps) => StreamFn;
