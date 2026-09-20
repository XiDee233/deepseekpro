/**
 * DeepSeek official-API pi-ai provider (Issue B2-T3).
 *
 * Registers the DeepSeek official API as a first-class pi-ai `Provider`
 * through `createProvider`, using the `Api = KnownApi | (string & {})`
 * extension point (`DEEPSEEK_API`):
 *
 *  - the provider is a **registration + delegation object**: it owns no
 *    credentials, no page state, no conversation chain. All backend behavior
 *    is delegated to the existing `submitOfficialDeepSeekStreaming`
 *    (single authority, AGENTS.md StreamFn rule) — no protocol logic is
 *    copied here;
 *  - the wire transcript is OpenAI-compatible messages: the pi Context is
 *    translated by the injected `mapMessages` (B2-T2 rules: text join,
 *    thinking → reasoningContent, toolResult → user XML serialization);
 *  - `auth` resolves the stored official-API key (ambient credential
 *    semantics: no key → "not configured");
 *  - `stream`/`streamSimple` both delegate to the same StreamFn body; the
 *    pi agent loop only consumes `stream`.
 *
 * The StreamFn mirrors the DS-web adapter's event protocol exactly (text
 * deltas, streaming XML tool-call parse, toolcall events, done/error
 * terminal), so the loop adapter's AGENT_* translation is backend-agnostic.
 * The official-API stream has no page conversation chain (no
 * parentMessageId): the request chain IS the pi Context transcript, so
 * fail-closed chain checks in the loop adapter are adapted for this backend
 * (B2-T5).
 *
 * Bundle guard: this module imports only `createProvider` plus the existing
 * official-api client — never pi-ai's OpenAI/Anthropic/... api modules or
 * the `openai` SDK (heavy SDKs stay out of the static graph; the
 * pi-bundle-budget probe asserts it).
 */
import { createProvider } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreams,
  StreamOptions,
  Usage,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { submitOfficialDeepSeekStreaming } from '../../deepseek/official-api';
import type { OfficialDeepSeekMessage } from '../../deepseek/official-api';
import { createStreamingToolCallParser } from '../../interceptor/streaming-tool-call-parser';
import { createStreamingToolTextAccumulator } from '../../interceptor/streaming-tool-text';
import type { ToolCall as CoreToolCall } from '../../types';
import type { ToolDescriptor } from '../../types';
import type { AgentDiagnosticSink } from '../../diagnostics/agent-contract';
import { createToolProtocolCounter } from '../../diagnostics/tool-protocol';
import { emitAgentDiagnostic } from '../../diagnostics/agent-reporter';
import {
  DEEPSEEK_API,
  DEEPSEEK_API_PROVIDER,
  type DeepSeekApiMessageMapper,
  type DeepSeekApiStreamFnDeps,
} from './official-api-port';

export interface DeepSeekApiProviderOptions {
  onDiagnostic?: AgentDiagnosticSink;
  /** Tool descriptors used to parse XML tool calls out of the text stream. */
  toolDescriptors: readonly ToolDescriptor[];
  /** Maps a parsed XML tool call to the pi ToolCall shape (like the web path). */
  mapToolCall: (call: { name: string; invocationName: string; payload: Record<string, unknown> }, index: number) => {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Builds the pi-ai provider for the DeepSeek official API. The returned
 * `Provider<'deepseek-api'>` streams OpenAI-compatible messages through
 * `submitOfficialDeepSeekStreaming`.
 */
export function createDeepSeekApiProvider(
  deps: DeepSeekApiStreamFnDeps,
  options: DeepSeekApiProviderOptions,
): ReturnType<typeof createProvider<typeof DEEPSEEK_API>> {
  const streamFn = createDeepSeekApiStreamFn(deps, options);

  return createProvider({
    id: DEEPSEEK_API_PROVIDER,
    name: 'DeepSeek API',
    auth: {
      apiKey: {
        name: 'DeepSeek API key',
        resolve: async () => {
          const apiKey = await deps.getApiKey();
          if (!apiKey) return undefined;
          return {
            auth: { apiKey },
            source: 'DeepSeek API key',
          };
        },
      },
    },
    models: [
      {
        id: 'deepseek-api',
        name: 'DeepSeek API (configured model)',
        api: DEEPSEEK_API,
        provider: DEEPSEEK_API_PROVIDER,
        baseUrl: '',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
    ],
    api: {
      stream: toSyncStream(streamFn),
      streamSimple: toSyncStream(streamFn),
    },
  });
}

/**
 * Builds the pi StreamFn over the official-API backend. The returned function
 * never rejects; failures are encoded as protocol events.
 */
export function createDeepSeekApiStreamFn(
  deps: DeepSeekApiStreamFnDeps,
  options: DeepSeekApiProviderOptions,
): StreamFn {
  const { getApiKey, getConfig, mapMessages, onReasoningChunk } = deps;
  const { toolDescriptors, mapToolCall, onDiagnostic } = options;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;

    const partial = createEmptyAssistantMessage(model);
    const emit = (event: AssistantMessageEvent) => stream.push(event);
    const snapshot = () => ({ ...partial, content: [...partial.content] });

    emit({ type: 'start', partial: snapshot() });

    void (async () => {
      const diagnosticProtocol = createToolProtocolCounter();
      let diagnosticChars = 0;
      let diagnosticParseErrors = 0;
      let diagnosticFinished = false;
      try {
        const apiKey = await getApiKey();
        if (!apiKey) {
          throw new Error('DeepSeek API key is not configured; cannot run the official-API backend.');
        }
        const config = await getConfig();

        const textAccumulator = createStreamingToolTextAccumulator(toolDescriptors);
        const toolCallParser = createStreamingToolCallParser(toolDescriptors);
        let lastVisibleText = '';
        let textContentIndex: number | null = null;
        let thinkingContentIndex: number | null = null;
        let lastThinkingText = '';
        let toolCallCount = 0;

        const emitText = (fullText: string) => {
          const delta = fullText.slice(lastVisibleText.length);
          lastVisibleText = fullText;
          if (!delta) return;
          if (textContentIndex === null) {
            textContentIndex = partial.content.length;
            partial.content.push({ type: 'text', text: fullText });
            emit({ type: 'text_start', contentIndex: textContentIndex, partial: snapshot() });
          } else {
            partial.content[textContentIndex] = { type: 'text', text: fullText };
          }
          emit({ type: 'text_delta', contentIndex: textContentIndex, delta, partial: snapshot() });
        };

        const emitThinking = (fullText: string) => {
          const delta = fullText.slice(lastThinkingText.length);
          lastThinkingText = fullText;
          if (!delta) return;
          if (thinkingContentIndex === null) {
            thinkingContentIndex = partial.content.length;
            partial.content.push({ type: 'thinking', thinking: fullText });
            emit({ type: 'thinking_start', contentIndex: thinkingContentIndex, partial: snapshot() });
          } else {
            partial.content[thinkingContentIndex] = { type: 'thinking', thinking: fullText };
          }
          emit({ type: 'thinking_delta', contentIndex: thinkingContentIndex, delta, partial: snapshot() });
        };

        const emitToolCall = (parsed: { name: string; invocationName: string; payload: Record<string, unknown> }) => {
          const toolCall = mapToolCall(parsed, toolCallCount);
          toolCallCount += 1;
          const contentIndex = partial.content.length;
          partial.content.push({ type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: {} });
          emit({ type: 'toolcall_start', contentIndex, partial: snapshot() });
          partial.content[contentIndex] = toolCall;
          emit({ type: 'toolcall_end', contentIndex, toolCall, partial: snapshot() });
        };

        const onParsed = (parsed: { completed: CoreToolCall[]; failed: CoreToolCall[] }) => {
          diagnosticParseErrors += [...parsed.completed, ...parsed.failed].filter((call) => call.parseError).length;
          for (const call of parsed.completed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
          for (const call of parsed.failed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
        };

        const turn = await submitOfficialDeepSeekStreaming({
          apiKey,
          config,
          messages: mapMessages(context.messages),
        }, {
          onTextChunk(text) {
            diagnosticProtocol.append(text);
            diagnosticChars += text.length;
            emitText(textAccumulator.append(text));
            onParsed(toolCallParser.append(text));
          },
          onReasoningChunk(text, fullText) {
            onReasoningChunk?.(text, fullText);
            emitThinking(fullText);
          },
        }, signal);
        diagnosticFinished = true;

        onParsed(toolCallParser.flush());
        emitText(textAccumulator.flush());
        if (textContentIndex !== null) {
          emit({
            type: 'text_end',
            contentIndex: textContentIndex,
            content: lastVisibleText,
            partial: snapshot(),
          });
        }
        if (thinkingContentIndex !== null) {
          emit({
            type: 'thinking_end',
            contentIndex: thinkingContentIndex,
            content: lastThinkingText,
            partial: snapshot(),
          });
        }

        // Tool calls are only detected from the streamed text; a turn whose
        // text is empty but finished is a plain stop (like the web path).
        partial.stopReason = partial.content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop';
        emit({ type: 'done', reason: partial.stopReason, message: snapshot() });
      } catch (err) {
        const aborted = signal?.aborted ?? false;
        partial.stopReason = aborted ? 'aborted' : 'error';
        partial.errorMessage = aborted ? 'Aborted' : (err instanceof Error ? err.message : String(err));
        emit({ type: 'error', reason: partial.stopReason, error: snapshot() });
      } finally {
        emitAgentDiagnostic(onDiagnostic, { event: 'model_stream_summary',
          wireChars: diagnosticChars, parseErrorCount: diagnosticParseErrors,
          streamFinished: diagnosticFinished, ...diagnosticProtocol.snapshot() });
      }
    })();

    return stream;
  };
}

/**
 * Adapts a deepseek-api provider to pi's `StreamFn` seam consumed by
 * `runAgentLoop`. The provider's `stream` is typed for `Model<'deepseek-api'>`
 * and `ApiStreamOptions`, while the loop passes the config model as
 * `Model<Api>` and `SimpleStreamOptions`. The runtime model is always the
 * provider's own catalog entry and the StreamFn body consumes only `signal`
 * from options, so this is a type-level widening only — no behavior change.
 */
export function deepSeekApiProviderToStreamFn(
  provider: ReturnType<typeof createProvider<typeof DEEPSEEK_API>>,
): StreamFn {
  return (model, context, options) =>
    provider.stream(
      model as Model<typeof DEEPSEEK_API>,
      context,
      options ? { ...options } : undefined,
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The released message mapper (B2-T2 contract): translates the pi Context
 * transcript to official-API wire messages.
 */
export function createDeepSeekApiMessageMapper(): DeepSeekApiMessageMapper {
  return (messages) => {
    const output: OfficialDeepSeekMessage[] = [];
    for (const message of messages) {
      if (message.role === 'toolResult') {
        const toolName = message.toolName ?? 'tool';
        const text = extractMessageText(message.content);
        output.push({
          role: 'user',
          content: `<${toolName}_result>\n${text}\n</${toolName}_result>`,
        });
        continue;
      }
      const text = extractMessageText(message.content);
      const toolCalls = extractMessageToolCalls(message.content);
      const reasoning = extractMessageThinking(message.content);
      output.push({
        role: message.role,
        content: toolCalls.length > 0 ? `${text}${toolCalls}` : text,
        ...(reasoning ? { reasoningContent: reasoning } : {}),
      });
    }
    return output;
  };
}

/**
 * Re-serializes assistant toolCall blocks to the XML wire protocol the model
 * itself produced (`<name>{json}</name>`). The official API has no native
 * function calling, so the assistant turn must be sent back verbatim —
 * mirroring the chat official-API loop, which stores the raw streamed text.
 */
function extractMessageToolCalls(
  content: string | ReadonlyArray<{ type: string; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }>,
): string {
  if (typeof content === 'string') return '';
  return content
    .filter((block) => block.type === 'toolCall')
    .map((block) => {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const args = block.arguments === undefined ? {} : block.arguments;
      let json: string;
      try {
        json = JSON.stringify(args);
      } catch {
        json = '{}';
      }
      return `<${name}>${json}</${name}>`;
    })
    .join('');
}

function extractMessageText(
  content: string | ReadonlyArray<{ type: string; text?: unknown; thinking?: unknown }>,
): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function extractMessageThinking(
  content: string | ReadonlyArray<{ type: string; text?: unknown; thinking?: unknown }>,
): string {
  if (typeof content === 'string') return '';
  return content
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking as string)
    .join('');
}

/**
 * Adapts the pi StreamFn (whose type allows a Promise return) to pi-ai's
 * `ProviderStreams` synchronous surface. The deepseek-api StreamFn always
 * returns its event stream synchronously; fail closed if upstream changes.
 */
function toSyncStream(streamFn: StreamFn): ProviderStreams['stream'] {
  return (model, context, options?: StreamOptions) => {
    const stream = streamFn(model, context, options);
    if (stream instanceof Promise) {
      throw new Error('deepseek-api StreamFn returned a Promise; provider stream requires a synchronous AssistantMessageEventStream');
    }
    return stream;
  };
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
  const emptyUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
