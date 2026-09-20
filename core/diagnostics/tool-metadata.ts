import type { ToolCall, ToolResult } from '../types';
import { DIAGNOSTIC_BUILD_ID } from './build-info';
import { classifyDiagnosticFailure } from './failure-kind';

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9:._+-]{1,160}$/.test(value) ? value : undefined;
}

/** Never serialize commands, arguments, output, error messages or grant IDs. */
export function toolDiagnosticMetadata(call: ToolCall, result?: ToolResult, elapsedMs?: number, failure?: unknown): string {
  return JSON.stringify({
    buildId: DIAGNOSTIC_BUILD_ID,
    toolCallId: identifier(call.id),
    requestId: identifier(call.source?.requestId),
    chatSessionId: identifier(call.source?.chatSessionId),
    loopId: identifier(call.source?.runId),
    toolName: identifier(call.name),
    ok: result?.ok,
    errorCode: identifier(result?.error?.code ?? call.parseError?.code),
    parseError: Boolean(call.parseError),
    elapsedMs,
    ...(failure || result?.error ? classifyDiagnosticFailure(failure ?? result?.error?.message) : {}),
  });
}
