import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { describe, expect, it, vi } from 'vitest';
import { parseTypeScriptSource } from './helpers/typescript-source';
import { createPromptSendGuard } from '../core/ui/prompt-send-interception';
import { startPendingInputSession } from '../core/inline-agent/pending-input-session';
import { selectContinuableToolDescriptors } from '../core/inline-agent/execution-policy';

const source = readFileSync('entrypoints/content.ts', 'utf8');
const names = ['beginPendingInputForTool', 'acquirePendingInputOwner', 'releasePendingInputOwner', 'startOwnedInlineAgentLoop', 'isInlineAgentRunning'];
const program = parseTypeScriptSource('entrypoints/content.ts', source);
const functions = program.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id?.name ?? ''))
  .map(node => transform(source.slice(node.start!, node.end!), { transforms: ['typescript'] }).code).join('\n');
const load = new Function('deps', `
  const { promptSendGuard, getCurrentChatSessionId, reportAgentDiagnostic, startInlineAgentLoop,
    startPendingInputSession, selectContinuableToolDescriptors, getToolAuthorizationForCall } = deps;
  let pendingInputOwner = null;
  let activeAgentAbort = null;
  const inlineAgentCapabilityScope = { active: true };
  const inlineAgentCapabilityEpoch = 1;
  const isInlineAgentEpochActive = () => true;
  const toolAuthorizationRequestAliases = new Map();
  const pendingInlineAgentLoopTasks = new Set();
  const findDeepSeekInputBox = () => document.querySelector('#composer');
  const contentT = (key) => key;
  const getCurrentRoutePendingMultimodalMedia = () => [];
  const showContentToast = () => {};
  ${functions}
  return { beginPendingInputForTool, startOwnedInlineAgentLoop, isInlineAgentRunning,
    getOwner: () => pendingInputOwner,
    finish: () => { if (pendingInputOwner) releasePendingInputOwner(pendingInputOwner); },
    settle: () => Promise.allSettled([...pendingInlineAgentLoopTasks]) };
`);
const descriptor = { id: 'web:search', name: 'web_search', provider: { kind: 'local', id: 'web' } };
const call = { name: 'web_search', descriptorId: 'web:search', source: { trigger: 'manual_chat', requestId: 'req', chatSessionId: 'chat' } };

function setup() {
  document.body.innerHTML = '<div id="composer"><textarea id="chat-input"></textarea><button aria-label="Send">Send</button></div>';
  const guard = createPromptSendGuard(); guard.start();
  const report = vi.fn(); let end!: () => void;
  const run = vi.fn(() => new Promise<void>(resolve => { end = resolve; }));
  const controller = load({ promptSendGuard: guard, getCurrentChatSessionId: () => 'chat', reportAgentDiagnostic: report,
    startInlineAgentLoop: run, startPendingInputSession, selectContinuableToolDescriptors,
    getToolAuthorizationForCall: () => ({ descriptors: [descriptor] }) });
  return { controller, report, run, end: () => end(), cleanup: () => { controller.finish(); guard.stop(); document.body.innerHTML = ''; } };
}

describe('first-tool input ownership', () => {
  it('queues before continuation startup, then hands the same queue to the loop', async () => {
    const test = setup();
    try {
      test.controller.beginPendingInputForTool(call);
      const first = test.controller.getOwner(); expect(first).not.toBeNull();
      expect(test.controller.isInlineAgentRunning('req')).toBe(false);
      expect(test.controller.isInlineAgentRunning('other-request')).toBe(true);
      const input = document.querySelector('textarea')!; input.value = 'during first tools';
      const nativeSend = vi.fn(); document.querySelector('button[aria-label="Send"]')!.addEventListener('click', nativeSend);
      document.querySelector<HTMLElement>('[data-dpp-agent-send]')!.click();
      expect(first.session.queue.list()[0].text).toBe('during first tools');
      expect(nativeSend).not.toHaveBeenCalled();
      test.controller.beginPendingInputForTool(call);
      expect(test.controller.getOwner()).toBe(first);
      const payload = { capabilityScopeRequestId: 'req', chatSessionId: 'chat', loopId: 'loop' };
      test.controller.startOwnedInlineAgentLoop(payload);
      expect(test.run).toHaveBeenCalledWith(payload, first.session);
      expect(test.controller.isInlineAgentRunning('req')).toBe(true);
      test.end(); await test.controller.settle();
      expect(test.controller.getOwner()).toBeNull();
      expect(document.querySelector('[data-dpp-agent-send]')).not.toBeNull();
      expect((document.querySelector('[data-dpp-send-hidden]') as HTMLElement).style.display).toBe('none');
      expect(input.value).toBe('during first tools');
    } finally { test.cleanup(); }
  });

  it('releases unconsumed first-turn input on failure without exposing the native button', () => {
    const test = setup();
    try {
      test.controller.beginPendingInputForTool(call);
      const owner = test.controller.getOwner(); owner.session.queue.enqueue({ text: 'keep this' });
      test.controller.finish();
      expect(document.querySelector('textarea')!.value).toBe('keep this');
      expect(document.querySelectorAll('[data-dpp-agent-send]')).toHaveLength(1);
      expect(test.controller.isInlineAgentRunning()).toBe(false);
    } finally { test.cleanup(); }
  });

  it('does not let unrelated sessions or non-advertised tools acquire the input queue', () => {
    const test = setup();
    try {
      test.controller.beginPendingInputForTool({ ...call, source: { ...call.source, chatSessionId: 'other' } });
      expect(test.controller.getOwner()).toBeNull();
      test.controller.beginPendingInputForTool({ ...call, name: 'unknown', descriptorId: 'unknown' });
      expect(test.controller.getOwner()).toBeNull();
    } finally { test.cleanup(); }
  });
});
