/**
 * DeepSeek-web StreamFn adapter (Issue A1-T2).
 *
 * Wraps the DeepSeek web session as a pi `StreamFn` model backend:
 *
 *  - `createDeepSeekTurnSubmitter` — thin adapter over `submitPromptStreaming`
 *    that mirrors the original loop's turn semantics exactly: client headers +
 *    PoW headers created once per turn, one completion dispatch without replay
 *    (a failed response does not prove the server rejected the message), and
 *    the 120s step timeout. The
 *    original loop's implementation is replaced by this module in Issue A3;
 *    until then the two copies share the extracted `step-control` helpers.
 *
 *  - `createDeepSeekStreamFn` — maps the DS-web text/tool-call stream into pi
 *    `AssistantMessageEventStream` protocol events. Never throws: request,
 *    model and runtime failures are encoded as protocol `error` events with a
 *    final AssistantMessage carrying stopReason "error"/"aborted"
 *    (StreamFn contract).
 *
 * The DS-web conversation chain stays the authority: `parentMessageId` is
 * read from and written back to the injected session state (never derived
 * from the pi context) — fail-closed against chain forks (risk (g)).
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createClientHeaders,
  createPowHeaders,
  submitPromptStreaming,
  type ModelTurn,
  type SubmitPromptInput,
} from '../../deepseek/adapter';
import { extractToolCalls } from '../../interceptor/tool-parser';
import { createStreamingToolCallParser } from '../../interceptor/streaming-tool-call-parser';
import { createStreamingToolTextAccumulator } from '../../interceptor/streaming-tool-text';
import type { ToolCall as CoreToolCall } from '../../types';
import { createStepSignal } from '../step-control';
import { createToolProtocolCounter } from '../../diagnostics/tool-protocol';
import { emitAgentDiagnostic } from '../../diagnostics/agent-reporter';
import type {
  DeepSeekStreamFnDeps,
  DeepSeekTurnCallbacks,
  DeepSeekTurnRequest,
  DeepSeekTurnResult,
  DeepSeekTurnSubmitter,
  ParsedXmlToolCall,
} from './stream-fn-port';

export interface DeepSeekTurnSubmitterOptions {
  powWasmUrl?: string;
}

/**
 * Builds the turn submitter: one turn = one PoW solve, one completion dispatch
 * and a 120s step timeout. Server acknowledgement is independent of completion.
 */
export function createDeepSeekTurnSubmitter(
  options: DeepSeekTurnSubmitterOptions = {},
): DeepSeekTurnSubmitter {
  const { powWasmUrl } = options;

  return async (request, callbacks, signal) => {
    const clientHeaders = createClientHeaders();
    const powHeaders = await createPowHeaders(clientHeaders, powWasmUrl);
    const input: SubmitPromptInput = {
      chatSessionId: request.chatSessionId,
      parentMessageId: request.parentMessageId,
      modelType: request.modelType,
      prompt: request.prompt,
      refFileIds: request.refFileIds,
      thinkingEnabled: request.thinkingEnabled,
      searchEnabled: request.searchEnabled,
      clientHeaders,
      powHeaders,
    };
    return submitOnce(input, callbacks, signal);
  };
}

/**
 * Builds the pi StreamFn over the DS-web backend. The returned function never
 * rejects; failures are encoded as protocol events.
 */
export function createDeepSeekStreamFn(deps: DeepSeekStreamFnDeps): StreamFn {
  const { submitTurn, session, serializePrompt, mapToolCall, toolDescriptors, turnDefaults } = deps;

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
        const request: DeepSeekTurnRequest = {
          chatSessionId: session.chatSessionId,
          parentMessageId: session.parentMessageId,
          modelType: turnDefaults.modelType ?? model.id ?? null,
          prompt: serializePrompt(context),
          refFileIds: turnDefaults.refFileIds,
          thinkingEnabled: turnDefaults.thinkingEnabled,
          searchEnabled: turnDefaults.searchEnabled,
        };

        const textAccumulator = createStreamingToolTextAccumulator(toolDescriptors);
        const toolCallParser = createStreamingToolCallParser(toolDescriptors);
        let lastVisibleText = '';
        let textContentIndex: number | null = null;
        let thinkingContentIndex: number | null = null;
        let lastThinkingText = '';
        let toolCallCount = 0;
        // Raw (un-stripped) stream text for the released fallback parse:
        // legacy DSML blocks are invisible to the streaming XML parser and are
        // only recovered at flush time.
        let fallbackRawText = '';
        let fallbackRawTruncated = false;
        const FALLBACK_PARSE_MAX_CHARS = 120_000;

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

        const emitToolCall = (parsed: ParsedXmlToolCall) => {
          const toolCall = mapToolCall(parsed, toolCallCount);
          toolCallCount += 1;
          const contentIndex = partial.content.length;
          partial.content.push({ type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: {} });
          emit({ type: 'toolcall_start', contentIndex, partial: snapshot() });
          partial.content[contentIndex] = toolCall;
          emit({ type: 'toolcall_end', contentIndex, toolCall, partial: snapshot() });
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

        const onParsed = (parsed: { completed: CoreToolCall[]; failed: CoreToolCall[] }) => {
          diagnosticParseErrors += [...parsed.completed, ...parsed.failed].filter((call) => call.parseError).length;
          for (const call of parsed.completed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
          for (const call of parsed.failed) {
            emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
          }
        };

        let acceptedRequestId: number | null = null;
        let acceptedResponseId: number | null = null;
        const accept: NonNullable<DeepSeekTurnCallbacks['onRequestAccepted']> = (receipt) => {
          if (!Number.isSafeInteger(receipt.requestMessageId) || receipt.requestMessageId <= 0) return;
          if (acceptedRequestId !== null && acceptedRequestId !== receipt.requestMessageId) {
            throw new Error('DeepSeek changed the request message identity within one response stream.');
          }
          if (acceptedRequestId === receipt.requestMessageId && acceptedResponseId === receipt.responseMessageId) return;
          acceptedRequestId = receipt.requestMessageId;
          acceptedResponseId = receipt.responseMessageId;
          deps.onRequestAccepted?.(receipt);
        };
        const callbacks: DeepSeekTurnCallbacks = {
          onRequestDispatched: deps.onRequestDispatched,
          onRequestAccepted: accept,
          onTextChunk(text) {
            diagnosticProtocol.append(text);
            diagnosticChars += text.length;
            if (!fallbackRawTruncated) {
              if (fallbackRawText.length + text.length > FALLBACK_PARSE_MAX_CHARS) {
                fallbackRawTruncated = true;
                fallbackRawText = '';
              } else {
                fallbackRawText += text;
              }
            }
            emitText(textAccumulator.append(text));
            onParsed(toolCallParser.append(text));
          },
          onReasoningChunk(reasoning, fullReasoning) {
            emitThinking(fullReasoning);
          },
          onTokenSpeed(progress) {
            deps.onTokenSpeed?.(progress);
          },
        };

        const result = await submitTurn(request, callbacks, signal);
        diagnosticFinished = result.finished;
        if (result.requestMessageId !== null && Number.isSafeInteger(result.requestMessageId)
          && result.requestMessageId > 0) {
          accept({ requestMessageId: result.requestMessageId, responseMessageId: result.responseMessageId });
        }

        // Fail-closed stream termination (Issue: mid-output silent stop): a
        // DeepSeek web stream is only complete once the server patches
        // FINISHED onto the response. When the stream ends without it (the
        // connection dropped or the server interrupted the response), the
        // partial text must NEVER be presented as a finished turn — surface
        // it as a visible error so the loop reports AGENT_LOOP_ERROR instead
        // of stopping on a seemingly normal message. User aborts keep their
        // silent 'aborted' semantics.
        if (!result.finished && !signal?.aborted) {
          throw new Error('DeepSeek response stream ended before completion (the response was interrupted).');
        }

        // The conversation chain authority: the page session, not this turn's
        // transcript, owns the next parent message id.
        session.setParentMessageId(result.responseMessageId);

        onParsed(toolCallParser.flush());
        emitText(textAccumulator.flush());
        if (!fallbackRawTruncated && fallbackRawText) {
          const shouldFallback = fallbackRawText.includes('｜DSML｜')
            || (toolCallCount === 0 && fallbackRawText.includes('<'));
          if (shouldFallback) {
            for (const call of extractToolCalls(fallbackRawText, { descriptors: toolDescriptors })) {
              emitToolCall({ name: call.name, invocationName: call.invocationName ?? call.name, payload: call.payload });
            }
          }
        }
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

        partial.stopReason = partial.content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop';
        emit({ type: 'done', reason: partial.stopReason, message: snapshot() });
      } catch (err) {
        const aborted = signal?.aborted ?? false;
        partial.stopReason = aborted ? 'aborted' : 'error';
        partial.errorMessage = aborted ? 'Aborted' : (err instanceof Error ? err.message : String(err));
        emit({ type: 'error', reason: partial.stopReason, error: snapshot() });
      } finally {
        emitAgentDiagnostic(deps.onDiagnostic, { event: 'model_stream_summary',
          wireChars: diagnosticChars, parseErrorCount: diagnosticParseErrors,
          streamFinished: diagnosticFinished, ...diagnosticProtocol.snapshot() });
      }
    })();

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A completion creates remote messages. Once dispatched, failure is not
 * evidence that the server rejected it; never replay automatically. */
async function submitOnce(
  input: SubmitPromptInput,
  callbacks: DeepSeekTurnCallbacks,
  parentSignal: AbortSignal | undefined,
): Promise<DeepSeekTurnResult> {
  const signal = parentSignal ?? new AbortController().signal;
  if (signal.aborted) throw signal.reason ?? new Error('Aborted');
  const stepTimeout = createStepSignal(signal);
  try {
    const turn: ModelTurn = await submitPromptStreaming(input, {
      retainAssistantText: false,
      onRequestDispatched: callbacks.onRequestDispatched,
      onRequestAccepted: callbacks.onRequestAccepted,
      onTextChunk: callbacks.onTextChunk,
      onReasoningChunk: callbacks.onReasoningChunk,
      onTokenSpeed: callbacks.onTokenSpeed,
    }, stepTimeout.signal);
    return { assistantText: turn.assistantText, responseMessageId: turn.responseMessageId,
      requestMessageId: turn.requestMessageId, finished: turn.finished };
  } catch (error) {
    if (!signal.aborted && stepTimeout.timedOut()) {
      throw new Error('DeepSeek agent step timed out; the request was not replayed.');
    }
    throw error;
  } finally {
    stepTimeout.clear();
  }
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
