import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';
import { createPendingInputQueue } from '../core/inline-agent/pending-input';
import { startPendingInputSession } from '../core/inline-agent/pending-input-session';

const mocks = vi.hoisted(() => ({ web: vi.fn(), api: vi.fn() }));
vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test' }),
  createPowHeaders: vi.fn(async () => ({})), submitPromptStreaming: mocks.web,
}));
vi.mock('../core/deepseek/official-api', async (original) => ({
  ...await original<typeof import('../core/deepseek/official-api')>(), submitOfficialDeepSeekStreaming: mocks.api,
}));
vi.mock('../core/chat/api-key', () => ({ getDeepSeekApiKey: vi.fn(async () => 'test-key') }));
vi.mock('../core/chat/official-api-config', () => ({ getOfficialApiChatConfig: vi.fn(async () => ({ model: 'deepseek-chat', thinking: 'disabled', reasoningEffort: 'high' })) }));
vi.mock('../core/inline-agent/step-control', async (original) => ({
  ...await original<typeof import('../core/inline-agent/step-control')>(), waitBetweenDeepSeekRequests: vi.fn(async () => {}),
}));
vi.mock('../core/inline-agent/pi/tool-bridge', async (original) => {
  const actual = await original<typeof import('../core/inline-agent/pi/tool-bridge')>();
  return { ...actual, createPiLoopBudgetMap: () => ({ ...actual.createPiLoopBudgetMap(), maxSteps: 2 }) };
});
const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
const toolText = '<shell_exec>{"command":"echo ok"}</shell_exec>';
const payload: InlineAgentStartPayload = {
  loopId: 'loop-input', chatSessionId: 'chat-input', parentMessageId: 100,
  originalPrompt: 'Perform the original task', agentTaskPrompt: 'Perform the original task',
  toolExecutions: [], locale: 'en', promptOptions: { modelType: null, thinkingEnabled: false, searchEnabled: false, refFileIds: [] },
  toolDescriptors: [{ id: 'test:shell', name: 'shell_exec', invocationName: 'shell_exec', title: 'Shell', description: 'Shell',
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    execution: { mode: 'auto', enabled: true, risk: 'low' } }],
};
function turn(text: string, responseId: number, during?: () => void) {
  return async (_input: unknown, handlers: { onTextChunk(text: string): void }) => {
    during?.(); handlers.onTextChunk(text);
    return { assistantText: '', requestMessageId: responseId - 1, responseMessageId: responseId, finished: true };
  };
}
const executeTool = async () => ({ name: 'shell_exec', result: { ok: true, summary: 'ok' } });

beforeEach(() => { mocks.web.mockReset(); mocks.api.mockReset(); });

describe('input delivery on the owned conversation chain', () => {
  it('sends a composer insertion in the next web request with the latest parent', async () => {
    document.body.innerHTML = '<textarea id="chat-input"></textarea><button aria-label="Send">Send</button>';
    const session = startPendingInputSession();
    const textarea = document.querySelector('textarea')!;
    const native = vi.fn(); textarea.addEventListener('keydown', native);
    mocks.web.mockImplementationOnce(turn(toolText, 102, () => {
      textarea.value = 'Use JSON output';
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      document.querySelector<HTMLButtonElement>('[data-dpp-steer]')!.click();
    })).mockImplementationOnce(turn('Done.', 104));
    const post = vi.fn();
    try {
      await runInlineAgentLoop(payload, { post, executeTool, signal: new AbortController().signal, pendingInput: session.queue });
      expect(native).not.toHaveBeenCalled();
      expect(mocks.web).toHaveBeenCalledTimes(2);
      expect(mocks.web.mock.calls[1][0]).toMatchObject({ chatSessionId: 'chat-input', parentMessageId: 102 });
      expect(mocks.web.mock.calls[1][0].prompt).toContain('Use JSON output');
      expect(mocks.web.mock.calls[1][0].prompt).toContain('Perform the original task');
      expect(session.queue.size()).toBe(0);
      expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.objectContaining({ finalText: 'Done.' }));
    } finally { session.dispose(); document.body.innerHTML = ''; }
  });

  it('does not drop input when the current model turn produces a final answer', async () => {
    const queue = createPendingInputQueue();
    mocks.web.mockImplementationOnce(turn('First answer.', 102, () => { queue.enqueue({ text: 'One more requirement' }); }))
      .mockImplementationOnce(turn('Updated answer.', 104));
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool, signal: new AbortController().signal, pendingInput: queue });
    expect(mocks.web).toHaveBeenCalledTimes(2);
    expect(mocks.web.mock.calls[1][0].prompt).toContain('One more requirement');
    expect(mocks.web.mock.calls[1][0].parentMessageId).toBe(102);
  });

  it('delivers after-task input only once the tool work has completed', async () => {
    const queue = createPendingInputQueue(); queue.enqueue({ text: 'Follow-up task', delivery: 'queue' });
    mocks.web.mockImplementationOnce(turn(toolText, 102)).mockImplementationOnce(turn('Task done.', 104))
      .mockImplementationOnce(turn('Follow-up done.', 106));
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool, signal: new AbortController().signal, pendingInput: queue });
    expect(mocks.web).toHaveBeenCalledTimes(3);
    expect(mocks.web.mock.calls[1][0].prompt).not.toContain('Follow-up task');
    expect(mocks.web.mock.calls[2][0].prompt).toContain('Follow-up task');
    expect(mocks.web.mock.calls[2][0].parentMessageId).toBe(104);
  });

  it('holds the loop at budget pause, then resumes on its last response id', async () => {
    const queue = createPendingInputQueue(); const onInputPause = vi.fn(); const post = vi.fn();
    mocks.web.mockImplementationOnce(turn(toolText, 102)).mockImplementationOnce(turn(toolText, 104))
      .mockImplementationOnce(turn('Finished after continue.', 106));
    const run = runInlineAgentLoop(payload, { post, executeTool, signal: new AbortController().signal, pendingInput: queue, onInputPause });
    await vi.waitFor(() => expect(onInputPause).toHaveBeenCalledWith(expect.objectContaining({ paused: true })));
    expect(mocks.web).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.some(([type]) => type === 'AGENT_LOOP_COMPLETE')).toBe(false);
    queue.enqueue({ text: 'Continue' });
    await run;
    expect(mocks.web.mock.calls[2][0].parentMessageId).toBe(104);
    expect(onInputPause).toHaveBeenLastCalledWith(expect.objectContaining({ paused: false }));
  });

  it('Stop aborts a paused loop without another model request', async () => {
    const queue = createPendingInputQueue(); const abort = new AbortController(); const onInputPause = vi.fn();
    mocks.web.mockImplementationOnce(turn(toolText, 102)).mockImplementationOnce(turn(toolText, 104));
    const run = runInlineAgentLoop(payload, { post: vi.fn(), executeTool, signal: abort.signal, pendingInput: queue, onInputPause });
    await vi.waitFor(() => expect(onInputPause).toHaveBeenCalled());
    abort.abort(); await run;
    expect(mocks.web).toHaveBeenCalledTimes(2);
  });

  it('returns failed input to the queue without automatically replaying a request', async () => {
    const queue = createPendingInputQueue(); queue.enqueue({ text: 'Keep this input' });
    mocks.web.mockRejectedValue(new Error('terminal network failure'));
    await runInlineAgentLoop(payload, { post: vi.fn(), executeTool, signal: new AbortController().signal, pendingInput: queue });
    expect(queue.list().map((entry) => entry.text)).toEqual(['Keep this input']);
  });

  it('also preserves user-role insertion in the official API transcript', async () => {
    const queue = createPendingInputQueue();
    mocks.api.mockImplementationOnce(turn('First answer.', 102, () => { queue.enqueue({ text: 'API follow-up' }); }))
      .mockImplementationOnce(turn('Final answer.', 104));
    await runInlineAgentLoop({ ...payload, modelBackend: 'official-api' }, { post: vi.fn(), executeTool,
      signal: new AbortController().signal, pendingInput: queue });
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'API follow-up' }),
    ]));
  });
});

it('does not repeat acknowledged searches when a later turn only updates memory', async () => {
  const searches = Array.from({ length: 103 }, (_, i) => ({ name: 'web_search', result: { ok: true, summary: `SEARCH_RESULT_${i}` } }));
  const queue = createPendingInputQueue(); queue.enqueue({ text: 'hello once' });
  mocks.web.mockImplementationOnce(turn(toolText, 102)).mockImplementationOnce(turn('Done.', 104));
  await runInlineAgentLoop({ ...payload, toolExecutions: searches }, { post: vi.fn(), executeTool,
    signal: new AbortController().signal, pendingInput: queue });
  const first = mocks.web.mock.calls[0][0].prompt;
  const second = mocks.web.mock.calls[1][0].prompt;
  expect(first).toContain('SEARCH_RESULT_0'); expect(first).toContain('hello once');
  expect(second).not.toContain('SEARCH_RESULT_'); expect(second).not.toContain('hello once');
  expect(second).toContain('shell_exec');
  expect(mocks.web.mock.calls[1][0].parentMessageId).toBe(102);
});

it.each(['unknown', 'accepted'] as const)('never requeues %s web input after an interrupted response', async (state) => {
  const queue = createPendingInputQueue(); queue.enqueue({ text: 'do not repeat me' });
  mocks.web.mockImplementationOnce(async (_input, callbacks) => {
    callbacks.onRequestDispatched();
    if (state === 'accepted') callbacks.onRequestAccepted({ requestMessageId: 101, responseMessageId: 102 });
    callbacks.onTextChunk('partial answer', 'partial answer');
    throw new Error('connection closed');
  });
  const post = vi.fn(); const diagnostic = vi.fn(); const onContinuationMessage = vi.fn();
  await runInlineAgentLoop(payload, { post, executeTool, signal: new AbortController().signal,
    pendingInput: queue, onDiagnostic: diagnostic, onContinuationMessage });
  expect(mocks.web).toHaveBeenCalledTimes(1); expect(queue.size()).toBe(0);
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'user_input_submitted', inputSeq: 1, attempt: 1 }));
  if (state === 'accepted') {
    expect(onContinuationMessage).toHaveBeenCalledExactlyOnceWith(101, ['do not repeat me']);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'user_input_accepted', inputSeq: 1, nativeRequestMessageId: 101 }));
  } else {
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: 'user_input_uncertain', inputSeq: 1 }));
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_ERROR', expect.objectContaining({ error: expect.stringContaining('do not repeat me') }));
  }
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('do not repeat me');
});
