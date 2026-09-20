import { describe, expect, it, vi } from 'vitest';
import { startPendingInputSession } from '../core/inline-agent/pending-input-session';
import { SEND_HIDDEN_ATTRIBUTE } from '../core/ui/prompt-send-interception';

function buildComposer() {
  const textarea = document.createElement('textarea');
  textarea.id = 'chat-input';
  document.body.appendChild(textarea);

  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Send');
  document.body.appendChild(button);

  return {
    textarea,
    button,
    cleanup: () => {
      textarea.remove();
      button.remove();
    },
  };
}

function pressEnter(textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
}

describe('pending input session', () => {
  it('hides the native button while active and restores it after dispose', () => {
    const dom = buildComposer();
    const session = startPendingInputSession();

    expect(session.active()).toBe(true);
    expect(dom.button.getAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe('true');

    session.dispose();

    expect(session.active()).toBe(false);
    expect(dom.button.hasAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe(false);
    dom.cleanup();
  });

  it('routes a composer submit into the session queue', () => {
    const dom = buildComposer();
    const session = startPendingInputSession();

    dom.textarea.value = 'switch to JSON output';
    pressEnter(dom.textarea);

    expect(session.queue.size()).toBe(1);
    expect(session.queue.list()[0]?.text).toBe('switch to JSON output');
    expect(dom.textarea.value).toBe('');

    session.dispose();
    dom.cleanup();
  });

  it('reports rejected enqueues through the diagnostic hook', () => {
    const dom = buildComposer();
    const onEnqueued = vi.fn();
    const session = startPendingInputSession({ onEnqueued });

    dom.textarea.value = 'first';
    pressEnter(dom.textarea);
    expect(onEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );

    onEnqueued.mockClear();
    dom.textarea.value = '   ';
    pressEnter(dom.textarea);
    expect(onEnqueued).not.toHaveBeenCalled();

    session.dispose();
    dom.cleanup();
  });

  it('keeps the queue bounded by the shared item limit', () => {
    const dom = buildComposer();
    const session = startPendingInputSession();

    for (let i = 0; i < 7; i += 1) {
      dom.textarea.value = `message ${i}`;
      pressEnter(dom.textarea);
    }

    // The queue admits at most 5 entries; rejected text remains in the composer.
    expect(session.queue.size()).toBe(5);
    expect(dom.textarea.value).toBe('message 6');

    session.dispose();
    dom.cleanup();
  });

  it('stops capturing and clears the queue on dispose', () => {
    const dom = buildComposer();
    const session = startPendingInputSession();

    dom.textarea.value = 'before dispose';
    pressEnter(dom.textarea);
    expect(session.queue.size()).toBe(1);

    session.dispose();
    expect(session.queue.size()).toBe(0);

    dom.textarea.value = 'after dispose';
    pressEnter(dom.textarea);
    expect(session.queue.size()).toBe(0);
    expect(dom.textarea.value).toBe('after dispose');

    dom.cleanup();
  });

  it('tolerates a composer with no native send button', () => {
    const textarea = document.createElement('textarea');
    textarea.id = 'chat-input';
    document.body.appendChild(textarea);

    const session = startPendingInputSession();
    textarea.value = 'no button';
    pressEnter(textarea);

    expect(session.queue.size()).toBe(1);

    expect(() => session.dispose()).not.toThrow();
    textarea.remove();
  });

  it('does not throw when interception cannot be installed', () => {
    // A document with no composer at all: interception degrades to a no-op and
    // the run must still be able to proceed.
    const empty = document.createElement('div');
    document.body.appendChild(empty);

    expect(() => {
      const session = startPendingInputSession();
      session.dispose();
    }).not.toThrow();

    empty.remove();
  });

  it('dispose is idempotent', () => {
    const dom = buildComposer();
    const session = startPendingInputSession();

    session.dispose();
    expect(() => session.dispose()).not.toThrow();
    expect(session.active()).toBe(false);

    dom.cleanup();
  });
});


describe('pending input end-of-run handling', () => {
  it('keeps rejected input in the composer after admission closes', () => {
    const dom = buildComposer(); const session = startPendingInputSession();
    session.closeAdmission(); dom.textarea.value = 'do not lose this'; pressEnter(dom.textarea);
    expect(dom.textarea.value).toBe('do not lose this'); expect(session.queue.size()).toBe(0);
    session.dispose(); dom.cleanup();
  });

  it('restores unconsumed input alongside a newer draft on disposal', () => {
    const dom = buildComposer(); const session = startPendingInputSession();
    dom.textarea.value = 'queued input'; pressEnter(dom.textarea);
    dom.textarea.value = 'new draft'; session.dispose();
    expect(dom.textarea.value).toBe('new draft\n\nqueued input'); dom.cleanup();
  });

  it('does not copy an old task input into a different conversation on teardown', () => {
    const dom = buildComposer(); const session = startPendingInputSession();
    dom.textarea.value = 'old task'; pressEnter(dom.textarea);
    dom.textarea.value = 'new conversation draft'; session.dispose(false);
    expect(dom.textarea.value).toBe('new conversation draft'); dom.cleanup();
  });
});

describe('pending cards outside the composer', () => {
  it('queues by default, then promotes or removes a card without a native send', () => {
    const dom = buildComposer(); const box = document.createElement('div');
    document.body.append(box); box.append(dom.textarea, dom.button);
    const nativeSend = vi.fn(); box.addEventListener('click', nativeSend);
    const session = startPendingInputSession({ findInputBox: () => box });
    try {
      const dock = document.querySelector<HTMLElement>('.dpp-agent-pending-input')!;
      expect(box.contains(dock)).toBe(false);
      expect(dock.style.display).toBe('none');
      expect(dock.querySelector('select')).toBeNull();
      dom.textarea.value = 'additional requirement';
      document.querySelector<HTMLElement>('[data-dpp-agent-send]')!.click();
      expect(nativeSend).not.toHaveBeenCalled();
      const queued = session.queue.list()[0];
      expect(queued.delivery).toBe('queue');
      expect(dock.style.display).toBe('flex');
      expect(dock.nextElementSibling).toBe(box);
      expect(dock.style.position).toBe('');
      expect(dock.style.bottom).toBe('');
      dock.querySelector<HTMLButtonElement>('[data-dpp-steer]')!.click();
      expect(session.queue.list()[0]).toEqual({ ...queued, delivery: 'steer' });
      expect(dock.querySelector<HTMLButtonElement>('[data-dpp-steer]')!.disabled).toBe(true);
      dock.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click();
      expect(session.queue.size()).toBe(0); expect(dock.style.display).toBe('none');
    } finally { session.dispose(); box.remove(); dom.cleanup(); }
    expect(document.querySelector('.dpp-agent-pending-input')).toBeNull();
  });

  it('steers immediately when paused and leaves a rejected attachment draft untouched', () => {
    const dom = buildComposer(); let allowed = false;
    const session = startPendingInputSession({ canAccept: () => allowed });
    try {
      dom.textarea.value = 'draft'; pressEnter(dom.textarea);
      expect(dom.textarea.value).toBe('draft'); expect(session.queue.size()).toBe(0);
      allowed = true; session.setPaused(true); pressEnter(dom.textarea);
      expect(session.queue.list()[0]).toMatchObject({ text: 'draft', delivery: 'steer' });
    } finally { session.dispose(); dom.cleanup(); }
  });
});

it('keeps task activity visible with an empty input queue and identifies outstanding tools', () => {
  vi.useFakeTimers(); const dom = buildComposer(); let timestamp = 0;
  const host = document.createElement('div'); host.className = 'dpp-agent-status-line'; document.body.append(host);
  const session = startPendingInputSession({ now: () => timestamp, findActivityAnchor: () => host });
  try {
    const activity = document.querySelector<HTMLElement>('[data-dpp-task-activity]')!;
    expect(activity.textContent).toContain('Preparing');
    const statusDone = session.trackTool('req:status', 'shell_status');
    const execDone = session.trackTool('req:exec', 'shell_exec');
    expect(activity.textContent).toContain('shell_status / shell_exec');
    timestamp = 18000; vi.advanceTimersByTime(1000);
    expect(activity.textContent).toContain('18s');
    session.setActivity('stopping'); session.closeAdmission();
    expect(activity.dataset.phase).toBe('stopping');
    expect(activity.textContent).toContain('waiting for active work');
    statusDone(); expect(activity.textContent).not.toContain('shell_status');
    expect(activity.textContent).toContain('shell_exec'); execDone();
    session.dispose(); expect(document.querySelector('[data-dpp-task-activity]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  } finally { session.dispose(); host.remove(); dom.cleanup(); vi.useRealTimers(); }
});

it('adds activity after the token badge while preserving both the badge and original header', () => {
  const dom = buildComposer();
  const header = document.createElement('div'); header.textContent = 'Running · step 2 · 3 tools · 16s';
  const badge = document.createElement('span'); badge.textContent = '0 tok'; document.body.append(header, badge);
  const session = startPendingInputSession({ findActivityAnchor: () => badge });
  try {
    const activity = document.querySelector<HTMLElement>('[data-dpp-task-activity]')!;
    expect(badge.nextSibling).toBe(activity);
    expect(activity.classList.contains('dpp-token-speed-badge')).toBe(true);
    expect(activity.style.font).toBe('');
    expect(activity.style.border).toBe('');
    expect(badge.hasAttribute('data-dpp-activity-anchor')).toBe(false);
    expect(badge.textContent).toBe('0 tok');
    expect(header.textContent).toBe('Running · step 2 · 3 tools · 16s');
    expect(activity.closest('.dpp-agent-pending-input')).toBeNull();
    session.dispose(); expect(badge.hasAttribute('data-dpp-activity-anchor')).toBe(false);
    expect(badge.textContent).toBe('0 tok');
  } finally { session.dispose(); header.remove(); badge.remove(); dom.cleanup(); }
});
