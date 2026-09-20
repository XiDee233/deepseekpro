import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDiagnosticEvent } from '../core/diagnostics/agent-contract';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';

const mocks = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer secret-token' }),
  createPowHeaders: vi.fn(async () => ({})), submitPromptStreaming: mocks.submit,
}));
vi.mock('../core/inline-agent/step-control', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/inline-agent/step-control')>(),
  waitBetweenDeepSeekRequests: vi.fn(async () => {}),
}));
const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
const payload: InlineAgentStartPayload = {
  loopId: 'loop-diag', chatSessionId: 'chat-diag', capabilityScopeRequestId: 'request-diag', parentMessageId: 1,
  originalPrompt: 'secret-user-prompt', agentTaskPrompt: 'secret-user-prompt', toolExecutions: [], toolDescriptors: [], locale: 'en',
  promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
};
function response(text: string) {
  return async (_input: unknown, handlers: { onTextChunk(text: string): void }) => {
    handlers.onTextChunk(text);
    return { assistantText: '', requestMessageId: 2, responseMessageId: 3, finished: true };
  };
}
describe('inline loop diagnostic decisions', () => {
  it('reports the native continuation request id separately from the assistant id', async () => {
    mocks.submit.mockImplementation(response('Done.'));
    const onContinuationMessage = vi.fn();
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool: vi.fn(), signal: new AbortController().signal,
      onContinuationMessage });
    expect(onContinuationMessage).toHaveBeenCalledExactlyOnceWith(2, []);
  });
  beforeEach(() => { mocks.submit.mockReset(); });
  it.each([
    ['secret-answer', 'natural_answer'],
    ['<task_complete>{"summary":"secret-answer"}</task_complete>', 'task_complete_signal'],
  ])('records the actual stop branch without logging answer text: %s', async (text, reason) => {
    mocks.submit.mockImplementation(response(text));
    const events: AgentDiagnosticEvent[] = [];
    const post = vi.fn();
    await runInlineAgentLoop(payload, { post, executeTool: vi.fn(), signal: new AbortController().signal,
      onDiagnostic: (event) => events.push(event) });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'loop_started', requestId: 'request-diag', loopId: 'loop-diag' }),
      expect.objectContaining({ event: 'turn_finished', modelStopReason: 'stop', toolCount: 0 }),
      expect.objectContaining({ event: 'model_stream_summary', streamFinished: true, wireChars: text.length }),
      expect.objectContaining({ event: 'turn_decision', reason }),
      expect.objectContaining({ event: 'loop_finished', reason }),
    ]));
    expect(events.filter((event) => event.event === 'loop_finished')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.anything());
  });

  it('distinguishes a nudge budget pause from task completion', async () => {
    mocks.submit.mockImplementation(response('I will read the file now.'));
    const events: AgentDiagnosticEvent[] = [];
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool: vi.fn(), signal: new AbortController().signal,
      onDiagnostic: (event) => events.push(event) });
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'nudge_queued', nudgeCount: 1 }),
      expect.objectContaining({ event: 'loop_finished', reason: 'nudge_exhausted' }),
    ]));
  });

  it('records model failure without echoing its potentially sensitive message', async () => {
    mocks.submit.mockRejectedValue(new Error('secret-network-error'));
    const events: AgentDiagnosticEvent[] = [];
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool: vi.fn(), signal: new AbortController().signal,
      onDiagnostic: (event) => events.push(event) });
    expect(events).toContainEqual(expect.objectContaining({ event: 'loop_finished', reason: 'model_error' }));
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('does not change completion when the diagnostic sink throws', async () => {
    mocks.submit.mockImplementation(response('Done.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const post = vi.fn();
    try {
      await runInlineAgentLoop(payload, { post, executeTool: vi.fn(), signal: new AbortController().signal,
        onDiagnostic: () => { throw new Error('secret'); } });
      expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.objectContaining({ finalText: 'Done.' }));
    } finally { warn.mockRestore(); }
  });
});
