import type { AgentDiagnosticEvent } from './agent-contract';

/** Classification only. Never return arbitrary error text, URLs or credentials. */
export function classifyDiagnosticFailure(error: unknown): Pick<AgentDiagnosticEvent, 'failureKind' | 'httpStatus'> {
  const text = (typeof error === 'string' ? error : error instanceof Error ? error.message : '').slice(0, 2048);
  const status = /\bHTTP\s+(\d{3})\b/i.exec(text);
  const httpStatus = status ? Number(status[1]) : undefined;
  if (httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599) {
    return { failureKind: httpStatus === 401 || httpStatus === 403 ? 'authentication' : 'http', httpStatus };
  }
  if (/timed?\s*out|timeout/i.test(text)) return { failureKind: 'timeout' };
  if (/ended before completion|response was interrupted/i.test(text)) return { failureKind: 'interrupted_stream' };
  if (/failed to fetch|network|ECONN|ENOTFOUND/i.test(text)) return { failureKind: 'network' };
  if (/API key is not configured|auth token was rejected/i.test(text)) return { failureKind: 'authentication' };
  if (/JSON|parse/i.test(text)) return { failureKind: 'parse' };
  return { failureKind: 'unknown' };
}
