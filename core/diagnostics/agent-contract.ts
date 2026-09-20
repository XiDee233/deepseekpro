/** Metadata-only diagnostics. IDs are correlation claims, never authorization. */
export const AGENT_DIAGNOSTIC_EVENTS = [
  'response_received', 'response_tools_settled', 'continuation_decision',
  'loop_started', 'model_request', 'turn_finished', 'turn_decision',
  'nudge_queued', 'tool_result', 'loop_finished',
  'stream_started', 'stream_summary', 'stream_failed', 'tool_parsed', 'tool_received',
  'tool_dispatch_finished',
  'content_ready', 'loop_stop_requested',
  'model_stream_summary',
  'agent_anchor_decision', 'agent_ui_mounted', 'agent_ui_detached', 'agent_restore_render',
  'message_visibility',
  'user_input_queued', 'user_input_submitted', 'user_input_failed', 'loop_paused', 'loop_resumed',
  'composer_owned', 'user_input_intercepted',
  'send_button_replaced', 'composer_send_routed',
  'model_request_dispatched', 'model_request_accepted', 'user_input_accepted', 'user_input_uncertain', 'message_visibility_failed',
] as const;
export const AGENT_DIAGNOSTIC_REASONS = [
  'internal_response', 'already_running', 'no_continuable_tools', 'missing_chain',
  'missing_authorization', 'inactive_document', 'anchor_unavailable', 'started',
  'response_superseded', 'authorization_failed', 'startup_failed',
  'step_budget', 'missing_chain_with_tools', 'empty_response_without_chain',
  'text_without_chain', 'tools_pending', 'task_complete_signal',
  'nudge_exhausted', 'nudge_resolved', 'nudge_needed', 'natural_answer',
  'aborted', 'model_error', 'loop_error', 'engine_ended',
  'stream_error', 'fetch_rejected', 'empty_body', 'parse_rejected', 'tool_failed',
  'user_stop', 'lifecycle_stop', 'loop_replaced', 'timeout',
  'anchor_matched', 'anchor_missing', 'anchor_ambiguous', 'anchor_claimed', 'anchor_identity_changed',
  'user_input_pending', 'user_input_rejected',
  'owned_continuation', 'continuation_placeholder', 'assistant_visible', 'ordinary_visible',
  'user_input_visible',
] as const;
export type AgentDiagnosticReason = typeof AGENT_DIAGNOSTIC_REASONS[number];
export interface AgentDiagnosticEvent {
  event: typeof AGENT_DIAGNOSTIC_EVENTS[number];
  reason?: AgentDiagnosticReason;
  requestId?: string;
  chatSessionId?: string;
  loopId?: string;
  toolCallId?: string;
  assistantMessageId?: number;
  stepIndex?: number;
  requestCount?: number;
  nudgeCount?: number;
  toolCount?: number;
  continuableToolCount?: number;
  pendingToolCount?: number;
  failedToolCount?: number;
  parseErrorCount?: number;
  textLength?: number;
  elapsedMs?: number;
  hasChain?: boolean;
  isNudge?: boolean;
  nudgeNeeded?: boolean;
  ok?: boolean;
  backend?: 'web' | 'official-api';
  modelStopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'pending';
  failureKind?: 'timeout' | 'network' | 'http' | 'authentication' | 'interrupted_stream' | 'parse' | 'unknown';
  httpStatus?: number;
  stage?: 'interceptor' | 'content' | 'loop';
  transport?: 'fetch' | 'xhr';
  frameCount?: number;
  wireChars?: number;
  descriptorCount?: number;
  dsmlMarkers?: number;
  dsmlToolCalls?: number;
  dsmlCalls?: number;
  dsmlInvokes?: number;
  visibleDsmlMarkers?: number;
  fallbackTruncated?: boolean;
  streamFinished?: boolean;
  anchorMessageId?: number;
  matchedMessageId?: number;
  finalResponseMessageId?: number;
  candidateCount?: number;
  renderedStepCount?: number;
  restored?: boolean;
  nativeFinalOwned?: boolean;
  anchorSource?: 'message_attribute' | 'virtual_item_key';
  messageId?: number;
  hidden?: boolean;
  parentMessageId?: number;
  inputCount?: number;
  inputChars?: number;
  inputSeq?: number;
  nativeRequestMessageId?: number;
  attempt?: number;
  inputSource?: 'keyboard' | 'button' | 'form';
  inputRoute?: 'native' | 'queue' | 'blocked' | 'stop';
  addedCount?: number;
  removedCount?: number;
}
export type AgentDiagnosticSink = (event: AgentDiagnosticEvent) => void;
export interface AgentDiagnosticPayload extends AgentDiagnosticEvent {
  observedAt: number;
  buildId: string;
}

const strings = new Set(['requestId', 'chatSessionId', 'loopId', 'toolCallId', 'buildId']);
const numbers = new Set([
  'observedAt', 'assistantMessageId', 'stepIndex', 'requestCount', 'nudgeCount',
  'toolCount', 'continuableToolCount', 'pendingToolCount', 'failedToolCount',
  'parseErrorCount', 'textLength', 'elapsedMs',
  'frameCount', 'wireChars', 'descriptorCount', 'dsmlMarkers', 'dsmlToolCalls',
  'dsmlCalls', 'dsmlInvokes', 'visibleDsmlMarkers',
  'httpStatus',
  'anchorMessageId', 'matchedMessageId', 'finalResponseMessageId', 'candidateCount', 'renderedStepCount',
  'messageId', 'parentMessageId', 'inputCount', 'inputChars',
  'addedCount', 'removedCount',
  'inputSeq', 'nativeRequestMessageId', 'attempt',
]);
const booleans = new Set(['hasChain', 'isNudge', 'nudgeNeeded', 'ok', 'fallbackTruncated', 'streamFinished', 'restored', 'nativeFinalOwned', 'hidden']);
const enums: Record<string, readonly string[]> = {
  event: AGENT_DIAGNOSTIC_EVENTS,
  reason: AGENT_DIAGNOSTIC_REASONS,
  backend: ['web', 'official-api'],
  modelStopReason: ['stop', 'length', 'toolUse', 'error', 'aborted', 'pending'],
  failureKind: ['timeout', 'network', 'http', 'authentication', 'interrupted_stream', 'parse', 'unknown'],
  stage: ['interceptor', 'content', 'loop'],
  transport: ['fetch', 'xhr'],
  anchorSource: ['message_attribute', 'virtual_item_key'],
  inputSource: ['keyboard', 'button', 'form'],
  inputRoute: ['native', 'queue', 'blocked', 'stop'],
};

/** Reject arbitrary text/objects rather than allowing diagnostics to ingest payloads. */
export function decodeAgentDiagnosticPayload(value: unknown): AgentDiagnosticPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Invalid agent diagnostic payload');
  }
  const input = value as Record<string, unknown>;
  if (!Object.hasOwn(input, 'event') || !Object.hasOwn(input, 'observedAt') || !Object.hasOwn(input, 'buildId')) {
    throw new Error('Missing agent diagnostic metadata');
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(input)) {
    const valid = strings.has(key)
      ? typeof field === 'string' && /^[a-zA-Z0-9:._+-]{1,160}$/.test(field)
      : numbers.has(key)
        ? typeof field === 'number' && Number.isSafeInteger(field) && field >= 0
        : booleans.has(key)
          ? typeof field === 'boolean'
          : Object.hasOwn(enums, key) && typeof field === 'string' && enums[key].includes(field);
    if (!valid) throw new Error('Invalid agent diagnostic field');
    result[key] = field;
  }
  return result as unknown as AgentDiagnosticPayload;
}
