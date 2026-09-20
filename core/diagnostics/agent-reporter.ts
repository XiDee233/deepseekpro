import { DIAGNOSTIC_BUILD_ID } from './build-info';
import type { AgentDiagnosticEvent, AgentDiagnosticPayload, AgentDiagnosticSink } from './agent-contract';

export function stampAgentDiagnostic(event: AgentDiagnosticEvent): AgentDiagnosticPayload {
  return {
    ...Object.fromEntries(Object.entries(event).filter(([key, value]) => value !== undefined
      && !(value === '' && ['requestId', 'chatSessionId', 'loopId', 'toolCallId'].includes(key)))),
    observedAt: Date.now(), buildId: DIAGNOSTIC_BUILD_ID,
  } as AgentDiagnosticPayload;
}

export function emitAgentDiagnostic(sink: AgentDiagnosticSink | undefined, event: AgentDiagnosticEvent): void {
  try {
    sink?.(event);
  } catch {
    // Diagnostics are best-effort: one attempt, no retries or effect on the loop.
    console.warn('[DeepSeek++] agent diagnostic delivery failed');
  }
}

export function createAgentDiagnosticReporter(
  send: (message: { type: 'RECORD_AGENT_DIAGNOSTIC'; payload: AgentDiagnosticPayload }) => Promise<unknown>,
): AgentDiagnosticSink {
  return (event) => deliverAgentDiagnostic(send, stampAgentDiagnostic(event));
}

export function deliverAgentDiagnostic(
  sendMessage: (message: { type: 'RECORD_AGENT_DIAGNOSTIC'; payload: AgentDiagnosticPayload }) => Promise<unknown>,
  payload: AgentDiagnosticPayload,
): void {
  emitAgentDiagnostic(() => {
    void sendMessage({ type: 'RECORD_AGENT_DIAGNOSTIC', payload }).then((response) => {
      if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
        console.warn('[DeepSeek++] agent diagnostic rejected');
      }
    }).catch(() => {
      // Never echo the transport error: it can contain request or page content.
      console.warn('[DeepSeek++] agent diagnostic delivery failed');
    });
  }, payload);
}
