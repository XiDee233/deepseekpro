import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAgentDiagnosticPayload } from '../core/diagnostics/agent-contract';
import { createAgentDiagnosticReporter, stampAgentDiagnostic } from '../core/diagnostics/agent-reporter';
import { createToolProtocolCounter, summarizeToolProtocol } from '../core/diagnostics/tool-protocol';
import { diagnosticLogBuffer } from '../core/diagnostics/log-buffer';
import { toolDiagnosticMetadata } from '../core/diagnostics/tool-metadata';
import { classifyDiagnosticFailure } from '../core/diagnostics/failure-kind';
import { createDiagnosticsRuntimeHandlers } from '../entrypoints/background/diagnostics-handlers';
import { authorizeRuntimeMessage, createRuntimeMessageContext } from '../core/messaging/runtime-boundary';

const payload = { event: 'continuation_decision', reason: 'no_continuable_tools',
  buildId: 'test-build', observedAt: 1, requestId: 'request-1', toolCount: 0 } as const;
const context = createRuntimeMessageContext({ id: 'test-extension', url: 'https://chat.deepseek.com/a/chat-1',
  origin: 'https://chat.deepseek.com', tab: { id: 3, url: 'https://chat.deepseek.com/a/chat-1' },
  frameId: 0, documentId: 'browser-document',
}, { runtimeId: 'test-extension', extensionOrigin: 'chrome-extension://test-extension', deepSeekOrigin: 'https://chat.deepseek.com' });

describe('metadata-only agent diagnostics', () => {
  it('records visibility decisions without including message text', () => {
    expect(decodeAgentDiagnosticPayload({ event: 'message_visibility', stage: 'content',
      messageId: 42, hidden: false, reason: 'assistant_visible', observedAt: 1, buildId: 'test-build',
    })).toMatchObject({ messageId: 42, hidden: false });
  });
  it('accepts render identity evidence without requiring response text', () => {
    expect(decodeAgentDiagnosticPayload({ event: 'agent_ui_mounted', stage: 'content',
      observedAt: 1, buildId: 'test-build', loopId: 'loop-1', anchorMessageId: 12,
      matchedMessageId: 12, anchorSource: 'virtual_item_key', restored: true,
    })).toMatchObject({ anchorMessageId: 12, matchedMessageId: 12, restored: true });
  });
  beforeEach(() => diagnosticLogBuffer.clear());
  afterEach(() => vi.restoreAllMocks());

  it('exports content events with browser-owned identity and the background build', async () => {
    const handlers = createDiagnosticsRuntimeHandlers({ getVersion: () => '1.14.0' });
    const record = handlers.find((handler) => handler.type === 'RECORD_AGENT_DIAGNOSTIC')!;
    const exportLogs = handlers.find((handler) => handler.type === 'EXPORT_DIAGNOSTIC_LOGS')!;
    const message = { type: 'RECORD_AGENT_DIAGNOSTIC', payload };
    expect(() => authorizeRuntimeMessage(message, context)).not.toThrow();
    await expect(record.handle(message, context)).resolves.toEqual({ ok: true });
    const exported = await exportLogs.handle({ type: 'EXPORT_DIAGNOSTIC_LOGS' }, context) as unknown as { buildId: string; entries: Array<{ details: string }> };
    expect(exported.buildId).toBe('unbundled');
    expect(JSON.parse(exported.entries[0].details)).toMatchObject({ ...payload, senderTabId: 3, senderDocumentId: 'browser-document' });
  });

  it.each([
    { ...payload, text: 'private prompt' }, { ...payload, payload: { command: 'secret' } },
    { ...payload, senderTabId: 99 }, { ...payload, reason: 'arbitrary' },
    { ...payload, toolCount: -1 }, { ...payload, observedAt: Infinity },
    { ...payload, requestId: 'x'.repeat(161) }, { ...payload, requestId: 'Bearer secret' },
    { ...payload, stage: 'root' }, { ...payload, event: 'arbitrary' },
  ])('rejects unknown fields, caller identity and unbounded values: %#', async (value) => {
    expect(() => decodeAgentDiagnosticPayload(value)).toThrow();
    const record = createDiagnosticsRuntimeHandlers({ getVersion: () => 'test' })[0];
    await expect(record.handle({ type: 'RECORD_AGENT_DIAGNOSTIC', payload: value }, context)).rejects.toThrow();
    expect(diagnosticLogBuffer.snapshot()).toEqual([]);
  });

  it('uses bounded, failure-isolated delivery without retries or raw errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error('Bearer private-token'));
    expect(() => createAgentDiagnosticReporter(send)({ event: 'loop_finished', reason: 'aborted' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[DeepSeek++] agent diagnostic delivery failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-token');
    const syncFailure = vi.fn(() => { throw new Error('secret'); });
    expect(() => createAgentDiagnosticReporter(syncFailure)({ event: 'loop_started' })).not.toThrow();
    expect(decodeAgentDiagnosticPayload(stampAgentDiagnostic({ event: 'loop_started', requestId: undefined })).event).toBe('loop_started');
  });

  it('counts screenshot DSML variants across every chunk boundary without repairing them', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="x">private</｜DSML｜invoke></｜DSML｜tool_calls>'
      + '< | | DSML | | calls>< | | DSML | | invoke name="x">private</ | | DSML | | calls>';
    const expected = summarizeToolProtocol(text);
    expect(expected).toMatchObject({ dsmlToolCalls: 1, dsmlCalls: 1, dsmlInvokes: 2 });
    for (let i = 0; i < text.length; i++) {
      const counter = createToolProtocolCounter();
      counter.append(text.slice(0, i));
      counter.append(text.slice(i));
      expect(counter.snapshot()).toEqual(expected);
    }
    const tiny = createToolProtocolCounter();
    for (const char of text) tiny.append(char);
    expect(tiny.snapshot()).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain('private');
  });

  it('retains tool correlation and error codes without command, output or error content', () => {
    const value = toolDiagnosticMetadata({ id: 'tool-1', name: 'shell_exec', raw: 'secret-raw',
      payload: { command: 'secret-command' }, source: { trigger: 'agent_run', requestId: 'request-1', runId: 'loop-1' } },
    { ok: false, summary: 'secret-summary', detail: 'secret-detail', output: 'secret-output',
      error: { code: 'tool_call_json_invalid', message: 'secret-error', retryable: false } }, 25);
    expect(value).not.toContain('secret');
    expect(JSON.parse(value)).toMatchObject({ toolCallId: 'tool-1', requestId: 'request-1', loopId: 'loop-1',
      errorCode: 'tool_call_json_invalid', elapsedMs: 25, ok: false });
  });

  it.each([
    ['DeepSeek completion failed with HTTP 429: secret', 'http', 429],
    ['auth token rejected HTTP 401: secret', 'authentication', 401],
    ['DeepSeek agent step timed out after retry: secret', 'timeout', undefined],
    ['Failed to fetch https://secret.example', 'network', undefined],
    ['response stream ended before completion secret', 'interrupted_stream', undefined],
  ])('classifies %s without retaining the error body', (message, failureKind, httpStatus) => {
    const value = classifyDiagnosticFailure(new Error(message));
    expect(value.failureKind).toBe(failureKind);
    expect(value.httpStatus).toBe(httpStatus);
    expect(JSON.stringify(value)).not.toContain('secret');
  });
});

it('validates owned-composer diagnostics with only bounded event metadata', () => {
  for (const inputSource of ['keyboard', 'button', 'form'] as const) {
    expect(decodeAgentDiagnosticPayload(stampAgentDiagnostic({
      event: 'user_input_intercepted', stage: 'content', inputSource, ok: false,
    }))).toMatchObject({ event: 'user_input_intercepted', inputSource, ok: false });
  }
  expect(decodeAgentDiagnosticPayload(stampAgentDiagnostic({ event: 'composer_owned', candidateCount: 1 }))).toMatchObject({ candidateCount: 1 });
  expect(() => decodeAgentDiagnosticPayload({ ...stampAgentDiagnostic({ event: 'composer_owned' }), inputSource: 'arbitrary' })).toThrow();
});

it('accepts replacement and send-route metadata but rejects arbitrary routes', () => {
  expect(decodeAgentDiagnosticPayload(stampAgentDiagnostic({ event: 'send_button_replaced', candidateCount: 1, addedCount: 1, removedCount: 1 }))).toMatchObject({ candidateCount: 1 });
  for (const inputRoute of ['native', 'queue', 'blocked'] as const) {
    expect(decodeAgentDiagnosticPayload(stampAgentDiagnostic({ event: 'composer_send_routed', inputSource: 'button', inputRoute }))).toMatchObject({ inputRoute });
  }
  expect(() => decodeAgentDiagnosticPayload({ ...stampAgentDiagnostic({ event: 'composer_send_routed' }), inputRoute: 'arbitrary' })).toThrow();
});

it('accepts transport-bound input sequence and server receipt metadata', () => {
  const payload = stampAgentDiagnostic({ event: 'user_input_accepted', inputSeq: 3,
    nativeRequestMessageId: 51, assistantMessageId: 52, requestCount: 2, attempt: 1 });
  expect(decodeAgentDiagnosticPayload(payload)).toMatchObject({ inputSeq: 3, nativeRequestMessageId: 51 });
  expect(() => decodeAgentDiagnosticPayload({ ...payload, inputSeq: -1 })).toThrow();
});
