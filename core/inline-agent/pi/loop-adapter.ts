/**
 * pi-agent-core loop adapter (Issue A3-T1, B2-T5 dual backend).
 *
 * Drives the pi `runAgentLoop` over the selected model backend's StreamFn
 * and tool bridge, translating pi AgentEvents into the released AGENT_*
 * page protocol (locked by `tests/inline-agent-event-protocol-golden.test.ts`):
 *
 *  - one model request = one pi turn; a "step" = a request plus at most one
 *    nudge request (the released nudge semantics);
 *  - text deltas → AGENT_STREAM_CHUNK (12k clamp), tool execution start →
 *    AGENT_TOOL_DETECTED, step end → AGENT_STEP_COMPLETE, run end →
 *    AGENT_LOOP_COMPLETE / AGENT_LOOP_ERROR, abort → silent complete;
 *  - chain authority depends on the backend (B2):
 *      * `web` (default, released): the DS page conversation chain —
 *        `parentMessageId` lives in session state, tool calls without a
 *        continuable chain are blocked (beforeToolCall) and surfaced as an
 *        error, matching the original loop;
 *      * `official-api`: no page chain exists — the pi Context transcript
 *        IS the chain, so fail-closed checks verify the Context carries a
 *        valid assistant message before tools run.
 *
 * The released wire prompt contract (`<original_task>`/`<tool_results>`/
 * `<task_complete>`/nudge prompts) is preserved on the web path via
 * `buildContinuationPrompt` / `buildNudgePrompt` — pi's own prompt templates
 * are never used. The official-API path sends the pi Context as
 * OpenAI-compatible messages (mapMessages), which is the backend's native
 * shape; no page-injection template is involved either way.
 */
import type { Api, AssistantMessage, Model, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { StreamFn, AgentEvent, AgentLoopConfig } from '@earendil-works/pi-agent-core';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../../i18n';
import type { ToolCall, ToolDescriptor, ToolExecutionRecord, ToolProviderIdentity } from '../../types';
import { createClientHeaders } from '../../deepseek/adapter';
import { getDeepSeekApiKey } from '../../chat/api-key';
import { getOfficialApiChatConfig } from '../../chat/official-api-config';
import { createDeepSeekTurnSubmitter } from './deepseek-stream-fn';
import { createDeepSeekWebProvider, deepSeekWebProviderToStreamFn } from './deepseek-web-provider';
import { createDeepSeekApiProvider, createDeepSeekApiMessageMapper, deepSeekApiProviderToStreamFn } from './official-api-provider';
import type { DeepSeekSessionState, DeepSeekStreamFnDeps } from './stream-fn-port';
import {
  createPiAgentTools,
  createPiLoopBudgetMap,
  piToolResultToExecutionRecord,
} from './tool-bridge';
import {
  buildContinuationPrompt,
  buildNudgePrompt,
  extractTaskCompleteSignal,
  shouldNudge,
} from '../prompt';
import { stripRetiredArtifactProtocolBlocks } from '../retired-artifact';
import type {
  InlineAgentStartPayload,
  InlineAgentReasoningChunkMsg,
  InlineAgentStepCompleteMsg,
  InlineAgentStreamChunkMsg,
  InlineAgentToolDetectedMsg,
} from '../types';
import { INLINE_AGENT_MAX_STEPS } from '../types';
import type { PendingInput, PendingInputQueue } from '../pending-input';
import { waitBetweenDeepSeekRequests } from '../step-control';
import type { AgentDiagnosticEvent, AgentDiagnosticReason, AgentDiagnosticSink } from '../../diagnostics/agent-contract';
import { emitAgentDiagnostic } from '../../diagnostics/agent-reporter';
import { summarizeToolProtocol } from '../../diagnostics/tool-protocol';
import { classifyDiagnosticFailure } from '../../diagnostics/failure-kind';

export type PostFn = (type: string, data: unknown) => void;
export type ExecuteToolFn = (call: ToolCall) => Promise<ToolExecutionRecord>;

const INLINE_AGENT_STREAM_EVENT_MAX_CHARS = 12000;
const TRUNCATION_SUFFIX = '\n...[truncated]';

export interface InputPauseState {
  paused: boolean;
  stepIndex: number;
  totalTools: number;
  notice: string;
}

export interface PiLoopAdapterDeps {
  payload: InlineAgentStartPayload;
  post: PostFn;
  executeTool: ExecuteToolFn;
  signal: AbortSignal;
  onDiagnostic?: AgentDiagnosticSink;
  pendingInput?: PendingInputQueue;
  onInputPause?: (state: InputPauseState) => void;
  onContinuationMessage?: (messageId: number, userInput: readonly string[]) => void;
}

/** Runs the pi engine with the released inline-agent semantics. */
export async function runPiInlineAgentLoop(deps: PiLoopAdapterDeps): Promise<void> {
  const { payload, post, executeTool, signal, pendingInput } = deps;
  const { loopId, chatSessionId, toolDescriptors, promptOptions } = payload;
  const { powWasmUrl } = payload;
  const locale = payload.locale ?? DEFAULT_LOCALE;

  // ------------------------------------------------------------------ state
  const session: DeepSeekSessionState = {
    chatSessionId,
    parentMessageId: payload.parentMessageId,
    setParentMessageId: (id) => {
      session.parentMessageId = id;
    },
  };

  // Chain authority by backend (B2): the web path uses the DS page session
  // chain (`parentMessageId`); the official-API path has no page chain — the
  // pi Context transcript IS the chain, so `hasContinuableChain` is
  // trivially true there and fail-closed checks verify the Context carries a
  // valid assistant message instead (beforeToolCall).
  const backend = payload.modelBackend ?? 'web';
  const hasContinuableChain = (): boolean => {
    if (backend === 'official-api') return true;
    return session.parentMessageId !== null;
  };
  const chainResponseMessageId = (): number | null =>
    backend === 'official-api' ? null : session.parentMessageId;
  const collectedExecutions: ToolExecutionRecord[] = [...payload.toolExecutions];
  // Web history already contains accepted tool-result messages. Keep the full
  // run for UI/accounting, but send each result only until DS acknowledges it.
  let acknowledgedToolResults = 0;
  let requestToolResultsEnd = 0;
  let requestToolResultCount = 0;
  const executedInStep: ToolExecutionRecord[] = [];
  const descriptorByName = new Map<string, ToolDescriptor>(toolDescriptors.map((d) => [d.invocationName, d]));
  const nudge = {
    active: false, // serializer should build a nudge prompt for the current turn
    pendingTurn: false, // prepareNextTurn queued a nudge; the next turn is a nudge turn
    currentTurnIsNudge: false, // the turn now streaming is a nudge turn
    nudgedInStep: false, // this step already consumed its single nudge
    count: 0, // total nudges issued (token-speed request ids)
    lastAssistantText: '',
  };

  let stepIndex = 0; // completed steps (0-based index of the current step)
  let lastStepCompleted = false; // whether the current step already posted STEP_COMPLETE
  let stepText = ''; // current turn's visible text
  let lastPostedText = '';
  let stepReasoning = ''; // current step's accumulated reasoning text (per-turn thinking deltas)
  let lastPostedReasoning = '';
  let finalizeDone = false;
  let resolvedFinalText: string | null = null;
  let stopNotice: string | null = null;
  let lastTurnWasError = false;
  let lastErrorMessage = '';
  let lastTurnText = '';
  let lastTurnHasTools = false;
  let turnsElapsed = 0;
  let inputBatch: readonly PendingInput[] = [];
  let inputDelivery: 'not_sent' | 'unknown' | 'accepted' = 'not_sent';
  let acceptedInputMessageId: number | null = null;
  let inputFailureNotice = '';
  const restoreInputBatch = () => {
    if (inputBatch.length === 0) return;
    const batch = inputBatch;
    inputBatch = [];
    // Web delivery is committed by the server receipt, not by pi turn_end.
    // An ambiguous network failure must never put a possibly accepted message
    // back into a sendable queue or the composer's draft.
    if (backend === 'official-api' || inputDelivery === 'not_sent') {
      pendingInput?.restore(batch);
      for (const entry of batch) diagnose({ event: 'user_input_failed', inputSeq: entry.seq, inputChars: entry.text.length });
      return;
    }
    inputFailureNotice = translate(locale, inputDelivery === 'accepted'
      ? 'content.agent.inputAcceptedInterrupted' : 'content.agent.inputDeliveryUnknown');
    if (inputDelivery === 'unknown') {
      inputFailureNotice += `\n\n${batch.map((entry) => entry.text).join('\n\n')}`;
      for (const entry of batch) diagnose({ event: 'user_input_uncertain', inputSeq: entry.seq,
        inputChars: entry.text.length, requestCount });
    }
  };
  const startedAt = Date.now();
  let exitReason: AgentDiagnosticReason = 'engine_ended';
  const diagnose = (event: AgentDiagnosticEvent) => emitAgentDiagnostic(deps.onDiagnostic, {
    requestId: payload.capabilityScopeRequestId ?? `agent:${loopId}`,
    chatSessionId, loopId, backend, stepIndex, nudgeCount: nudge.count,
    ...event,
  });
  const decide = (stop: boolean, reason: AgentDiagnosticReason, nudgeNeeded?: boolean): boolean => {
    if (stop) exitReason = reason;
    diagnose({ event: 'turn_decision', reason, hasChain: hasContinuableChain(),
      isNudge: nudge.currentTurnIsNudge, ...(nudgeNeeded === undefined ? {} : { nudgeNeeded }),
      textLength: lastTurnText.length });
    return stop;
  };
  const diagnoseExit = (reason: AgentDiagnosticReason) => diagnose({
    event: 'loop_finished', reason, toolCount: collectedExecutions.length,
    elapsedMs: Date.now() - startedAt,
  });
  diagnose({ event: 'loop_started', toolCount: collectedExecutions.length, hasChain: hasContinuableChain() });

  const clampStreamEventText = (value: string): string =>
    value.length > INLINE_AGENT_STREAM_EVENT_MAX_CHARS
      ? `${value.slice(0, INLINE_AGENT_STREAM_EVENT_MAX_CHARS)}${TRUNCATION_SUFFIX}`
      : value;

  const postStreamChunk = (nextText: string) => {
    const fullText = clampStreamEventText(nextText);
    if (fullText === lastPostedText) return;
    lastPostedText = fullText;
    post('AGENT_STREAM_CHUNK', {
      loopId,
      stepIndex,
      text: '',
      fullText,
    } satisfies InlineAgentStreamChunkMsg);
  };

  const postReasoningChunk = (nextReasoning: string) => {
    const fullText = clampStreamEventText(nextReasoning);
    if (fullText === lastPostedReasoning) return;
    lastPostedReasoning = fullText;
    post('AGENT_REASONING_CHUNK', {
      loopId,
      stepIndex,
      fullText,
    } satisfies InlineAgentReasoningChunkMsg);
  };

  const postStepComplete = () => {
    post('AGENT_STEP_COMPLETE', {
      loopId,
      stepIndex,
      responseMessageId: chainResponseMessageId(),
      toolExecutions: [...executedInStep],
    } satisfies InlineAgentStepCompleteMsg);
  };

  const postToolDetected = (toolCallId: string, toolName: string, args: unknown) => {
    const descriptor = descriptorByName.get(toolName);
    post('AGENT_TOOL_DETECTED', {
      loopId,
      stepIndex,
      call: {
        id: toolCallId,
        name: descriptor?.name ?? toolName,
        invocationName: toolName,
        payload: (args ?? {}) as Record<string, unknown>,
        raw: '',
      },
    } satisfies InlineAgentToolDetectedMsg);
  };

  const providerFor = (toolName: string): ToolProviderIdentity =>
    descriptorByName.get(toolName)?.provider ?? {
      kind: 'local',
      id: 'unknown',
      displayName: 'Unknown',
      transport: 'in_process',
    };

  // ------------------------------------------------------------- DS backend
  // Shared per-run stream wiring: model selection + pacing wrapper. The web
  // path keeps the released semantics byte-for-byte (golden); the
  // official-api path is a peer backend over the same pi loop.
  let requestCount = 0;
  const mapToolCall = (call: { name: string; invocationName: string; payload: Record<string, unknown> }, index: number) => ({
    type: 'toolCall' as const,
    // XML indexes restart at zero for every model response. A single inline
    // run intentionally reuses one background authorization grant, so the raw
    // `xml:${index}` id made the first tool in turn 2 look like a replay of the
    // first tool in turn 1. Bind the id to the model-request sequence while
    // keeping it stable for any parsing/retry inside that same request.
    id: `turn:${requestCount}:xml:${index}`,
    name: call.invocationName,
    arguments: call.payload,
  });

  let streamFn: StreamFn;
  let model: Model<Api>;
  if (backend === 'official-api') {
    // B2: official API backend. No page chain: the pi Context transcript is
    // the chain (fail-closed checks in beforeToolCall/shouldStopAfterTurn
    // use the Context, see below).
    const provider = createDeepSeekApiProvider({
      getApiKey: () => getDeepSeekApiKey(),
      getConfig: () => getOfficialApiChatConfig(),
      mapMessages: createDeepSeekApiMessageMapper(),
    }, {
      toolDescriptors,
      mapToolCall,
      onDiagnostic: (event) => diagnose({ ...event, requestCount }),
    });
    model = provider.getModels()[0];
    streamFn = deepSeekApiProviderToStreamFn(provider);
  } else {
    const submitter = createDeepSeekTurnSubmitter({ powWasmUrl });
    const streamFnDeps = {
      onRequestDispatched: () => {
        inputDelivery = 'unknown';
        diagnose({ event: 'model_request_dispatched', requestCount, attempt: 1,
          toolCount: requestToolResultCount,
          parentMessageId: chainResponseMessageId() ?? undefined });
        for (const entry of inputBatch) diagnose({ event: 'user_input_submitted', requestCount, attempt: 1,
          parentMessageId: chainResponseMessageId() ?? undefined, inputSeq: entry.seq,
          inputCount: 1, inputChars: entry.text.length });
      },
      onRequestAccepted: (receipt) => {
        inputDelivery = 'accepted';
        acknowledgedToolResults = Math.max(acknowledgedToolResults, requestToolResultsEnd);
        diagnose({ event: 'model_request_accepted', requestCount, attempt: 1,
          parentMessageId: chainResponseMessageId() ?? undefined, nativeRequestMessageId: receipt.requestMessageId,
          assistantMessageId: receipt.responseMessageId ?? undefined });
        if (acceptedInputMessageId === receipt.requestMessageId) return;
        acceptedInputMessageId = receipt.requestMessageId;
        for (const entry of inputBatch) diagnose({ event: 'user_input_accepted', requestCount,
          inputSeq: entry.seq, nativeRequestMessageId: receipt.requestMessageId,
          assistantMessageId: receipt.responseMessageId ?? undefined });
        // Display is downstream of acknowledgement. A DOM callback failure
        // must not turn an accepted request into failed model delivery.
        try { deps.onContinuationMessage?.(receipt.requestMessageId, inputBatch.map((entry) => entry.text)); }
        catch { diagnose({ event: 'message_visibility_failed', messageId: receipt.requestMessageId }); }
      },
      onDiagnostic: (event) => diagnose({ ...event, requestCount }),
      submitTurn: submitter,
      session,
      serializePrompt: () => {
        requestToolResultsEnd = collectedExecutions.length;
        const newResults = collectedExecutions.slice(acknowledgedToolResults, requestToolResultsEnd);
        requestToolResultCount = newResults.length;
        if (nudge.active) {
          nudge.active = false;
          nudge.currentTurnIsNudge = true;
          return buildNudgePrompt(payload.originalPrompt, nudge.lastAssistantText, newResults, nudge.count, locale);
        }
        return buildContinuationPrompt(payload.originalPrompt, newResults, locale,
          inputBatch.map((entry) => entry.text));
      },
      mapToolCall,
      toolDescriptors,
      turnDefaults: {
        modelType: promptOptions.modelType,
        refFileIds: promptOptions.refFileIds,
        thinkingEnabled: promptOptions.thinkingEnabled,
        searchEnabled: promptOptions.searchEnabled,
      },
      onTokenSpeed: (progress) => {
        post('AGENT_TOKEN_SPEED', {
          ...progress,
          requestId: `agent:${loopId}:step:${stepIndex}${nudge.currentTurnIsNudge ? `:nudge:${nudge.count}` : ''}`,
          chatSessionId,
          modelType: progress.modelType ?? promptOptions.modelType,
        });
      },
    } satisfies DeepSeekStreamFnDeps;

    // The deepseek-web backend is registered as a first-class pi-ai provider
    // (B1): the loop consumes the released `runAgentLoop` seam through
    // `provider.stream` instead of a hand-built StreamFn. The provider owns no
    // session state (the injected `session` is the chain authority) and its
    // auth surface is ambient: `createClientHeaders` resolves the page session
    // headers or throws when the login token is missing — provider auth
    // resolution reports that as "not configured".
    const provider = createDeepSeekWebProvider({
      ...streamFnDeps,
      resolveAuthHeaders: () => {
        try {
          return createClientHeaders();
        } catch {
          return undefined;
        }
      },
    });
    model = provider.getModels()[0];
    streamFn = deepSeekWebProviderToStreamFn(provider);
  }

  // One 2.5–6.5s throttle delay before every DS request except the first
  // (released request pacing).
  const pacedStreamFn: StreamFn = async (model, context, options) => {
    if (requestCount > 0) {
      await waitBetweenDeepSeekRequests(signal);
    }
    requestCount += 1;
    inputDelivery = 'not_sent';
    acceptedInputMessageId = null;
    diagnose({ event: 'model_request', requestCount, hasChain: hasContinuableChain(),
      isNudge: nudge.active || nudge.currentTurnIsNudge, parentMessageId: chainResponseMessageId() ?? undefined });
    if (backend === 'official-api' && inputBatch.length > 0) diagnose({ event: 'user_input_submitted', requestCount,
      parentMessageId: chainResponseMessageId() ?? undefined, inputCount: inputBatch.length,
      inputChars: inputBatch.reduce((sum, entry) => sum + entry.text.length, 0) });
    return streamFn(model, context, options);
  };

  const piTools = createPiAgentTools({
    descriptors: toolDescriptors,
    executeTool,
    callSource: {
      requestId: payload.capabilityScopeRequestId ?? `agent:${loopId}`,
      chatSessionId,
    },
  });

  const budget = createPiLoopBudgetMap();
  let nextBudgetStop = budget.maxSteps;
  const waitForUserInput = async (reason: 'step_budget' | 'nudge_exhausted'): Promise<boolean> => {
    if (!pendingInput || !hasContinuableChain()) return false;
    const state = { stepIndex, totalTools: collectedExecutions.length,
      notice: buildInlineAgentBudgetNotice(locale, Math.max(1, stepIndex)) };
    deps.onInputPause?.({ ...state, paused: true });
    diagnose({ event: 'loop_paused', reason, parentMessageId: chainResponseMessageId() ?? undefined });
    const ready = await pendingInput.waitForInput(signal, 'steer');
    if (!ready || signal.aborted) return false;
    nextBudgetStop = stepIndex + budget.maxSteps;
    nudge.nudgedInStep = false;
    nudge.currentTurnIsNudge = false;
    stopNotice = null;
    resolvedFinalText = null;
    deps.onInputPause?.({ ...state, paused: false, notice: '' });
    diagnose({ event: 'loop_resumed', parentMessageId: chainResponseMessageId() ?? undefined });
    return true;
  };
  const takeInput = (entries: readonly PendingInput[]): AgentMessage[] => {
    if (entries.length === 0) return [];
    // A user follow-up after a no-tool answer is a new step, not a nudge that
    // overwrites the previous answer. Tool turns already closed their step.
    if (turnsElapsed > 0 && !lastStepCompleted) {
      postStepComplete();
      stepIndex += 1;
      lastStepCompleted = true;
    }
    resolvedFinalText = null;
    nudge.active = false;
    nudge.nudgedInStep = false;
    inputBatch = entries;
    nextBudgetStop = stepIndex + budget.maxSteps;
    return entries.map((entry) => ({ role: 'user' as const, content: entry.text, timestamp: entry.admittedAt }));
  };
  const config: AgentLoopConfig = {
    model,
    toolExecution: 'sequential',
    convertToLlm: (messages: AgentMessage[]): Message[] =>
      messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
    shouldStopAfterTurn: async ({ message }) => {
      lastTurnText = extractText(message);
      lastTurnHasTools = message.content.some((block) => block.type === 'toolCall');
      if (stepIndex >= nextBudgetStop) {
        if (await waitForUserInput('step_budget')) return decide(false, 'user_input_pending');
        if (stopNotice === null && collectedExecutions.length > 0) {
          stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex);
        }
        return decide(true, 'step_budget');
      }
      const text = lastTurnText;
      const hasTools = lastTurnHasTools;

      if (!hasContinuableChain()) {
        if (hasTools) {
          exitReason = 'missing_chain_with_tools';
          diagnose({ event: 'turn_decision', reason: exitReason, hasChain: false });
          throw new Error(chainErrorText(nudge.currentTurnIsNudge));
        }
        if (!text.trim()) {
          exitReason = 'empty_response_without_chain';
          diagnose({ event: 'turn_decision', reason: exitReason, hasChain: false });
          throw new Error('DeepSeek returned an empty agent continuation without a continuable response message.');
        }
        resolvedFinalText = text;
        return decide(true, 'text_without_chain');
      }
      if (hasTools) return decide(false, 'tools_pending');
      if (pendingInput && pendingInput.size() > 0) return decide(false, 'user_input_pending');

      if (extractTaskCompleteSignal(text)) {
        resolvedFinalText = text;
        return decide(true, 'task_complete_signal');
      }
      // Nudge decisions run on the USER-VISIBLE text: retired artifact XML
      // (an internal control protocol the loop cannot execute) is stripped
      // first, so a turn whose visible tail still promises a deliverable
      // ("now creating a report for you" with nothing renderable following)
      // is nudged instead of ending on an empty promise — the deliverable
      // must never be silently swallowed.
      const nudging = shouldNudge(
        payload.originalPrompt,
        collectedExecutions,
        stripRetiredArtifactProtocolBlocks(text),
      );
      if (nudge.currentTurnIsNudge) {
        if (nudging) {
          if (await waitForUserInput('nudge_exhausted')) return decide(false, 'user_input_pending');
          stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex + 1);
        } else {
          resolvedFinalText = text;
        }
        return decide(true, nudging ? 'nudge_exhausted' : 'nudge_resolved', nudging);
      }
      if (nudging) return decide(false, 'nudge_needed', true); // steering issues the single-step nudge
      resolvedFinalText = text;
      return decide(true, 'natural_answer', false);
    },
    // The pi inner loop only continues with another LLM call when tools were
    // executed or steering messages are pending. The released nudge semantics
    // (one no-tool correction request per step) are implemented as steering:
    // after a no-tool turn that still needs nudging, shouldStopAfterTurn
    // returns false and getSteeringMessages returns the nudge prompt message.
    getSteeringMessages: async () => {
      // The pi loop polls steering before the first turn too; the released
      // nudge semantics only apply after a real turn has run.
      if (signal.aborted) return [];
      const steers = pendingInput?.drainSteers() ?? [];
      if (steers.length > 0) return takeInput(steers);
      if (turnsElapsed === 0) return [];
      // Explicit after-task input takes precedence over a machine nudge once
      // the current task has returned a no-tool answer.
      if (!lastTurnHasTools && pendingInput && pendingInput.size() > 0) return [];
      if (!lastTurnHasTools && !nudge.nudgedInStep && hasContinuableChain()
        && !extractTaskCompleteSignal(lastTurnText)
        && shouldNudge(
          payload.originalPrompt,
          collectedExecutions,
          stripRetiredArtifactProtocolBlocks(lastTurnText),
        )) {
        nudge.count += 1;
        nudge.nudgedInStep = true;
        nudge.pendingTurn = true;
        nudge.active = true;
        diagnose({ event: 'nudge_queued', reason: 'nudge_needed' });
        // The nudge shows the model what the USER saw: retired artifact XML
        // is internal protocol, so the model sees the visible tail (e.g. the
        // empty promise) and re-delivers in a renderable form.
        nudge.lastAssistantText = stripRetiredArtifactProtocolBlocks(lastTurnText);
        return [{
          role: 'user',
          content: buildNudgePrompt(
            payload.originalPrompt,
            nudge.lastAssistantText,
            collectedExecutions,
            nudge.count,
            locale,
          ),
          timestamp: Date.now(),
        }];
      }
      return [];
    },
    getFollowUpMessages: async () => {
      if (signal.aborted || stepIndex >= nextBudgetStop) return [];
      return takeInput(pendingInput?.drainQueued() ?? []);
    },
    beforeToolCall: async ({ context }) => {
      if (!hasContinuableChain()) {
        return { block: true, reason: chainErrorText(nudge.currentTurnIsNudge) };
      }
      // Official-API backend: the pi Context transcript IS the chain, so
      // also fail closed unless the Context carries a valid assistant
      // message (the model actually produced a turn before tools run).
      if (backend === 'official-api' && !contextHasAssistantMessage(context)) {
        return { block: true, reason: chainErrorText(nudge.currentTurnIsNudge) };
      }
      return undefined;
    },
  };

  // --------------------------------------------------------------- event sink
  const handleEvent = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case 'turn_start':
        nudge.currentTurnIsNudge = false;
        // Released semantics: each request's visible text replaces the
        // previous one within a step (nudge text is not concatenated).
        stepText = '';
        lastPostedText = '';
        // Post-abort the pi engine may still start one more turn after a
        // tool batch; the released loop never emits that ghost step.
        if (signal.aborted && turnsElapsed > 0) return;
        if (nudge.pendingTurn) {
          nudge.pendingTurn = false;
        } else {
          lastStepCompleted = false;
          stepReasoning = '';
          lastPostedReasoning = '';
          post('AGENT_STEP_STARTED', { loopId, stepIndex });
        }
        break;
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent;
        const delta = assistantEvent.type === 'text_delta' ? assistantEvent.delta : '';
        if (delta) {
          stepText += delta;
          postStreamChunk(stepText);
        }
        if (assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
          stepReasoning += assistantEvent.delta;
          postReasoningChunk(stepReasoning);
        }
        break;
      }
      case 'tool_execution_start':
        postToolDetected(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_end': {
        diagnose({ event: 'tool_result', toolCallId: event.toolCallId, ok: !event.isError });
        const descriptor = descriptorByName.get(event.toolName);
        const resultMessage: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: [{ type: 'text', text: extractResultText(event.result) }],
          details: (event.result as { details?: unknown } | undefined)?.details,
          isError: event.isError,
          timestamp: Date.now(),
        };
        executedInStep.push(piToolResultToExecutionRecord({
          toolName: descriptor?.name ?? event.toolName,
          provider: providerFor(event.toolName),
          message: resultMessage,
        }));
        break;
      }
      case 'turn_end': {
        turnsElapsed += 1;
        const turnMessage = event.message as AssistantMessage;
        diagnose({ event: 'turn_finished', modelStopReason: turnMessage.stopReason,
          toolCount: turnMessage.content.filter((block) => block.type === 'toolCall').length,
          textLength: extractText(turnMessage).length,
          ...(turnMessage.stopReason === 'error' ? classifyDiagnosticFailure(turnMessage.errorMessage) : {}),
          ...summarizeToolProtocol(extractText(turnMessage)),
          hasChain: hasContinuableChain(), requestCount });
        if (turnMessage.stopReason === 'error' || turnMessage.stopReason === 'aborted') {
          restoreInputBatch();
          lastTurnWasError = true;
          lastErrorMessage = [turnMessage.errorMessage ?? 'DeepSeek agent turn failed.', inputFailureNotice].filter(Boolean).join('\n\n');
          stepText = '';
          lastPostedText = '';
          return;
        }
        inputBatch = [];
        const hasTools = turnMessage.content.some((block) => block.type === 'toolCall');
        if (hasTools) {
          // Fail-closed: tools without a continuable chain were blocked in
          // beforeToolCall; surface the refusal as the released error.
          if (!hasContinuableChain()) {
            throw new Error(chainErrorText(nudge.currentTurnIsNudge));
          }
          collectedExecutions.push(...executedInStep);
          postStepComplete();
          stepIndex += 1;
          lastStepCompleted = true;
          stepText = '';
          lastPostedText = '';
          executedInStep.length = 0;
          nudge.nudgedInStep = false;
        } else {
          stepText = extractText(turnMessage);
          postStreamChunk(stepText);
        }
        break;
      }
      case 'agent_end':
        finalize();
        break;
      default:
        break;
    }
  };

  const finalize = () => {
    if (finalizeDone) return;
    restoreInputBatch();
    finalizeDone = true;

    if (signal.aborted || lastTurnWasError && signal.aborted) {
      diagnoseExit('aborted');
      post('AGENT_LOOP_COMPLETE', {
        loopId,
        totalSteps: stepIndex,
        totalTools: collectedExecutions.length,
        finalText: inputFailureNotice,
      });
      return;
    }
    if (lastTurnWasError) {
      diagnoseExit('model_error');
      post('AGENT_LOOP_ERROR', {
        loopId,
        stepIndex,
        totalTools: collectedExecutions.length,
        error: lastErrorMessage,
      });
      return;
    }
    if (stopNotice === null && resolvedFinalText === null && collectedExecutions.length > 0
      && stepIndex >= INLINE_AGENT_MAX_STEPS) {
      stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex);
      exitReason = 'step_budget';
    }
    if (!lastStepCompleted) {
      postStepComplete();
    }
    let finalText = '';
    if (resolvedFinalText !== null) {
      finalText = resolvedFinalText;
    } else if (!signal.aborted && stopNotice !== null) {
      finalText = stopNotice;
    }
    diagnoseExit(exitReason);
    post('AGENT_LOOP_COMPLETE', {
      loopId,
      totalSteps: lastStepCompleted ? stepIndex : stepIndex + 1,
      totalTools: collectedExecutions.length,
      finalText,
    });
  };

  // ------------------------------------------------------------------- run
  try {
    const initialMessage: Message = {
      role: 'user',
      content: payload.originalPrompt,
      timestamp: Date.now(),
    };
    await runAgentLoop(
      [initialMessage],
      { systemPrompt: '', messages: [], tools: piTools },
      config,
      handleEvent,
      signal,
      pacedStreamFn,
    );
  } catch (err) {
    if (finalizeDone) return;
    restoreInputBatch();
    finalizeDone = true;
    if (signal.aborted) {
      diagnoseExit('aborted');
      post('AGENT_LOOP_COMPLETE', {
        loopId,
        totalSteps: stepIndex,
        totalTools: collectedExecutions.length,
        finalText: inputFailureNotice,
      });
      return;
    }
    diagnose({ event: 'loop_finished', reason: exitReason === 'engine_ended' ? 'loop_error' : exitReason,
      toolCount: collectedExecutions.length, elapsedMs: Date.now() - startedAt, ...classifyDiagnosticFailure(err) });
    post('AGENT_LOOP_ERROR', {
      loopId,
      stepIndex,
      totalTools: collectedExecutions.length,
      error: [err instanceof Error ? err.message : String(err), inputFailureNotice].filter(Boolean).join('\n\n'),
    });
  }
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function extractResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!content) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function chainErrorText(nudgeTurn: boolean): string {
  return nudgeTurn
    ? 'DeepSeek returned nudge tool calls without a continuable response message; refusing to execute tools outside the conversation chain.'
    : 'DeepSeek returned agent tool calls without a continuable response message; refusing to execute tools outside the conversation chain.';
}

/**
 * Official-API fail-closed check: the pi Context transcript is the chain, so
 * tools may only run after the model actually produced an assistant message
 * in this loop (a valid turn), not on an empty/seed Context.
 */
function contextHasAssistantMessage(context: { messages: ReadonlyArray<{ role: string }> }): boolean {
  return context.messages.some((message) => message.role === 'assistant');
}

function buildInlineAgentBudgetNotice(locale: SupportedLocale, completedSteps: number): string {
  return translate(locale, 'content.agent.budgetReached', { count: completedSteps });
}
