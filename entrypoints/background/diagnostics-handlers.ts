import {
  definePayloadlessRuntimeCommandHandler,
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import { diagnosticLogBuffer } from '../../core/diagnostics/log-buffer';
import { decodeAgentDiagnosticPayload } from '../../core/diagnostics/agent-contract';
import { DIAGNOSTIC_BUILD_ID } from '../../core/diagnostics/build-info';

export interface DiagnosticsRuntimeHandlerDependencies {
  getVersion(): string;
}

export function createDiagnosticsRuntimeHandlers(
  dependencies: DiagnosticsRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    defineRuntimeCommandHandler({
      type: 'RECORD_AGENT_DIAGNOSTIC',
      decode: (message) => decodeAgentDiagnosticPayload(message.payload),
      handle: (event, context) => {
        diagnosticLogBuffer.record({
          level: event.reason === 'model_error' || event.reason === 'loop_error' ? 'error' : 'info',
          source: 'inline-agent',
          message: event.event,
          details: JSON.stringify({
            ...event,
            // Browser-derived identity is separate from caller correlation claims.
            senderTabId: context.tabId,
            senderFrameId: context.frameId,
            senderDocumentId: context.documentId,
          }),
        });
        return { ok: true as const };
      },
    }),
    definePayloadlessRuntimeCommandHandler('EXPORT_DIAGNOSTIC_LOGS', () => ({
      exportedAt: new Date().toISOString(),
      extensionVersion: dependencies.getVersion(),
      buildId: DIAGNOSTIC_BUILD_ID,
      entries: diagnosticLogBuffer.snapshot(),
    })),
  ]);
}
