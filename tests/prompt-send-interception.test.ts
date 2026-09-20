import { describe, expect, it, vi } from 'vitest';
import {
  installPromptSendInterception,
  createPromptSendGuard,
  readComposerSubmission,
  shouldInterceptComposerEnter,
  SEND_HIDDEN_ATTRIBUTE,
  type ComposerEnterEvent,
} from '../core/ui/prompt-send-interception';

function enterEvent(
  overrides: Partial<ComposerEnterEvent> = {},
): ComposerEnterEvent {
  return { key: 'Enter', shiftKey: false, ...overrides };
}

describe('composer enter decision', () => {
  it('intercepts a plain Enter', () => {
    expect(shouldInterceptComposerEnter(enterEvent())).toBe(true);
  });

  it('lets Shift+Enter through for newlines', () => {
    expect(shouldInterceptComposerEnter(enterEvent({ shiftKey: true }))).toBe(false);
  });

  it('ignores non-Enter keys', () => {
    expect(shouldInterceptComposerEnter(enterEvent({ key: 'a' }))).toBe(false);
  });

  it('lets IME composition Enter through', () => {
    expect(shouldInterceptComposerEnter(enterEvent({ isComposing: true }))).toBe(false);
    expect(shouldInterceptComposerEnter(enterEvent({ keyCode: 229 }))).toBe(false);
  });
});

describe('composer submission reading', () => {
  it('trims and returns non-empty text', () => {
    expect(readComposerSubmission('  hello  ')).toBe('hello');
  });

  it('returns null for whitespace-only input', () => {
    expect(readComposerSubmission('   ')).toBeNull();
    expect(readComposerSubmission('')).toBeNull();
  });
});

function buildDocument(options: { withButton?: boolean } = {}) {
  const withButton = options.withButton ?? true;
  const textarea = document.createElement('textarea');
  textarea.id = 'chat-input';
  document.body.appendChild(textarea);

  let button: HTMLButtonElement | null = null;
  if (withButton) {
    button = document.createElement('button');
    button.setAttribute('aria-label', 'Send');
    document.body.appendChild(button);
  }

  return {
    textarea,
    button,
    cleanup: () => {
      textarea.remove();
      button?.remove();
    },
  };
}

describe('send interception installer', () => {
  it('hides the native button and restores it on dispose', () => {
    const dom = buildDocument();
    const interception = installPromptSendInterception({ onSubmit: () => true });

    expect(dom.button?.getAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe('true');
    expect(dom.button?.style.display).toBe('none');

    interception.dispose();

    expect(dom.button?.hasAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe(false);
    expect(dom.button?.style.display).toBe('');
    dom.cleanup();
  });

  it('captures Enter, clears the composer, and forwards trimmed text', () => {
    const dom = buildDocument();
    const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ onSubmit });

    dom.textarea.value = '  change the output to JSON  ';
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    dom.textarea.dispatchEvent(event);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('change the output to JSON');
    expect(dom.textarea.value).toBe('');
    expect(event.defaultPrevented).toBe(true);

    interception.dispose();
    dom.cleanup();
  });

  it('stops sibling listeners on the composer from also submitting', () => {
    const dom = buildDocument();
    const onSubmit = vi.fn(() => true);
    const pageHandler = vi.fn();
    dom.textarea.addEventListener('keydown', pageHandler);

    const interception = installPromptSendInterception({ onSubmit });
    dom.textarea.value = 'queued';
    dom.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(pageHandler).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('queued');

    interception.dispose();
    dom.cleanup();
  });

  it('ignores empty submits but still blocks the page', () => {
    const dom = buildDocument();
    const onSubmit = vi.fn(() => true);
    const pageHandler = vi.fn();
    dom.textarea.addEventListener('keydown', pageHandler);

    const interception = installPromptSendInterception({ onSubmit });
    dom.textarea.value = '   ';
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    dom.textarea.dispatchEvent(event);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    interception.dispose();
    dom.cleanup();
  });

  it('lets Shift+Enter reach the page untouched', () => {
    const dom = buildDocument();
    const onSubmit = vi.fn(() => true);
    const pageHandler = vi.fn();
    dom.textarea.addEventListener('keydown', pageHandler);

    const interception = installPromptSendInterception({ onSubmit });
    dom.textarea.value = 'line';
    dom.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(dom.textarea.value).toBe('line');

    interception.dispose();
    dom.cleanup();
  });

  it('stops intercepting after dispose', () => {
    const dom = buildDocument();
    const onSubmit = vi.fn(() => true);
    const pageHandler = vi.fn();
    dom.textarea.addEventListener('keydown', pageHandler);

    const interception = installPromptSendInterception({ onSubmit });
    interception.dispose();

    dom.textarea.value = 'after dispose';
    dom.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(dom.textarea.value).toBe('after dispose');
    dom.cleanup();
  });

  it('tolerates a missing native button', () => {
    const dom = buildDocument({ withButton: false });
    const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ onSubmit });

    dom.textarea.value = 'no button here';
    dom.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));

    expect(onSubmit).toHaveBeenCalledWith('no button here');

    expect(() => interception.dispose()).not.toThrow();
    dom.cleanup();
  });

  it('skips hidden native buttons and picks a visible one', () => {
    const hidden = document.createElement('button');
    hidden.setAttribute('aria-label', 'Send');
    hidden.style.display = 'none';
    document.body.appendChild(hidden);

    const visible = document.createElement('button');
    visible.setAttribute('aria-label', 'Send');
    document.body.appendChild(visible);

    const interception = installPromptSendInterception({ onSubmit: () => true });

    expect(hidden.hasAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe(false);
    expect(visible.getAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe('true');

    interception.dispose();
    hidden.remove();
    visible.remove();
  });
});


describe('current DeepSeek send control', () => {
  it('blocks a click on the supplied send-arrow background and admits it once', () => {
    const dom = buildDocument({ withButton: false });
    const button = document.createElement('div');
    button.setAttribute('role', 'button');
    button.className = 'ds-button ds-button--primary ds-button--circle';
    button.innerHTML = '<div class="ds-button__background"></div><svg><path d="M8.3125 0.980206C8.66767 1.05312"></path></svg>';
    document.body.append(button);
    const nativeSend = vi.fn(); button.addEventListener('click', nativeSend);
    const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ onSubmit });
    dom.textarea.value = 'same task';
    button.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(nativeSend).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('same task');
    expect(dom.textarea.value).toBe('');
    interception.dispose(); button.remove(); dom.cleanup();
  });

  it('preserves rejected text and continues intercepting a React-replaced textarea', () => {
    const dom = buildDocument();
    const interception = installPromptSendInterception({ onSubmit: () => false });
    const replacement = document.createElement('textarea'); replacement.id = 'chat-input';
    dom.textarea.replaceWith(replacement);
    const nativeSend = vi.fn(); replacement.addEventListener('keydown', nativeSend);
    replacement.value = 'keep this rejected draft';
    replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(replacement.value).toBe('keep this rejected draft');
    expect(nativeSend).not.toHaveBeenCalled();
    interception.dispose(); replacement.remove(); dom.cleanup();
  });
});

describe('owned send replacement', () => {
  it('clones the exact native visual markup without native click handlers', () => {
    const dom = buildDocument({ withButton: false });
    const native = document.createElement('div');
    native.setAttribute('role', 'button'); native.tabIndex = 0;
    native.className = 'ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m ds-button--icon-relative-m _52c986b';
    native.style.cssText = '--dsl-button-height:34px';
    native.innerHTML = '<div class="ds-button__background"></div><div class="ds-button__icon"><svg><path d="M8.3125 0.980206C8.66767 1.05312"/></svg></div>';
    document.body.append(native);
    const originalStyle = native.getAttribute('style');
    const pageSend = vi.fn(); native.addEventListener('click', pageSend);
    const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ onSubmit });
    try {
      const clone = document.querySelector<HTMLElement>('[data-dpp-agent-send]')!;
      expect(clone.tagName).toBe(native.tagName);
      expect(clone.className).toBe(native.className);
      expect(clone.innerHTML).toBe(native.innerHTML);
      expect(clone.getAttribute('style')).toBe(originalStyle);
      expect(clone.nextSibling).toBe(native);
      expect(native.inert).toBe(true);
      dom.textarea.value = 'queued';
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        clone.firstElementChild!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('queued');
      expect(pageSend).not.toHaveBeenCalled();
    } finally { interception.dispose(); native.remove(); dom.cleanup(); }
    expect(document.querySelector('[data-dpp-agent-send]')).toBeNull();
  });

  it('keeps native controls hidden across inline-style resets and React replacements', async () => {
    const dom = buildDocument(); const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ onSubmit });
    const clone = document.querySelector('[data-dpp-agent-send]');
    try {
      dom.button!.style.setProperty('display', 'flex', 'important');
      dom.button!.removeAttribute(SEND_HIDDEN_ATTRIBUTE);
      await vi.waitFor(() => expect(dom.button!.style.display).toBe('none'));
      expect(dom.button!.style.getPropertyPriority('display')).toBe('important');
      const replacement = document.createElement('button'); replacement.setAttribute('aria-label', 'Send');
      dom.button!.replaceWith(replacement);
      await vi.waitFor(() => expect(replacement.hasAttribute(SEND_HIDDEN_ATTRIBUTE)).toBe(true));
      expect(clone!.isConnected).toBe(false);
      expect(document.querySelectorAll('[data-dpp-agent-send]')).toHaveLength(1);
      const pageSend = vi.fn(); replacement.addEventListener('click', pageSend);
      dom.textarea.value = 'replacement';
      (replacement.previousSibling as HTMLElement).click();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('replacement');
      expect(pageSend).not.toHaveBeenCalled();
      interception.dispose();
      expect(replacement.style.display).toBe('');
      replacement.remove();
    } finally { interception.dispose(); dom.cleanup(); }
  });

  it('blocks site window-capture listeners registered before the run claims input', () => {
    const dom = buildDocument(); const guard = createPromptSendGuard(); guard.start();
    const pageSend = vi.fn();
    for (const type of ['keydown', 'keypress', 'keyup', 'click', 'submit']) window.addEventListener(type, pageSend, true);
    const onSubmit = vi.fn(() => true);
    const interception = installPromptSendInterception({ guard, onSubmit });
    try {
      dom.textarea.value = 'early guard';
      for (const type of ['keydown', 'keypress', 'keyup']) dom.textarea.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true }));
      expect(pageSend).not.toHaveBeenCalled(); expect(onSubmit).toHaveBeenCalledTimes(1);
      interception.dispose();
      dom.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(pageSend).toHaveBeenCalledTimes(1);
    } finally {
      interception.dispose(); guard.stop(); dom.cleanup();
      for (const type of ['keydown', 'keypress', 'keyup', 'click', 'submit']) window.removeEventListener(type, pageSend, true);
    }
  });

  it('blocks native form submission and reports admission without recording the text', () => {
    const dom = buildDocument(); const form = document.createElement('form');
    document.body.append(form); form.append(dom.textarea);
    const onIntercept = vi.fn(); const onSubmit = vi.fn(() => false);
    const pageSend = vi.fn(); form.addEventListener('submit', pageSend);
    const interception = installPromptSendInterception({ onSubmit, onIntercept });
    try {
      dom.textarea.value = 'private draft';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(pageSend).not.toHaveBeenCalled();
      expect(onIntercept).toHaveBeenCalledExactlyOnceWith('form', false);
      expect(dom.textarea.value).toBe('private draft');
    } finally { interception.dispose(); form.remove(); dom.cleanup(); }
  });
});

describe('document lifetime replacement', () => {
  it('replaces before any run and retains the same clone after a run finishes', () => {
    const dom = buildDocument(); const pageSend = vi.fn();
    dom.button!.addEventListener('click', pageSend);
    const onReplacement = vi.fn(); const onRoute = vi.fn();
    const guard = createPromptSendGuard(document, { onReplacement, onRoute }); guard.start();
    try {
      const clone = document.querySelector<HTMLElement>('[data-dpp-agent-send]')!;
      expect(clone).not.toBeNull(); expect(dom.button!.inert).toBe(true);
      clone.click(); expect(pageSend).toHaveBeenCalledTimes(1);
      expect(onRoute).toHaveBeenLastCalledWith('button', 'native');
      const onSubmit = vi.fn(() => true);
      const run = guard.claim({ onSubmit });
      dom.textarea.value = 'during first tools'; clone.click();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('during first tools');
      expect(pageSend).toHaveBeenCalledTimes(1);
      expect(onRoute).toHaveBeenLastCalledWith('button', 'queue');
      run.dispose();
      expect(document.querySelector('[data-dpp-agent-send]')).toBe(clone);
      expect(dom.button!.style.display).toBe('none');
      expect(dom.button!.inert).toBe(true);
      clone.click(); expect(pageSend).toHaveBeenCalledTimes(2);
      expect(onReplacement).toHaveBeenCalledExactlyOnceWith(1, 1, 0);
    } finally { guard.stop(); dom.cleanup(); }
  });

  it('replaces late-mounted and redrawn controls while idle, with transition logs', async () => {
    const onReplacement = vi.fn(); const guard = createPromptSendGuard(document, { onReplacement });
    guard.start();
    const dom = buildDocument();
    try {
      await vi.waitFor(() => expect(document.querySelectorAll('[data-dpp-agent-send]')).toHaveLength(1));
      expect(onReplacement).toHaveBeenLastCalledWith(1, 1, 0);
      const newButton = document.createElement('button'); newButton.setAttribute('aria-label', 'Send');
      dom.button!.replaceWith(newButton);
      await vi.waitFor(() => expect(newButton.style.display).toBe('none'));
      expect(onReplacement).toHaveBeenLastCalledWith(1, 1, 1);
      const pageSend = vi.fn(); newButton.addEventListener('click', pageSend);
      document.querySelector<HTMLElement>('[data-dpp-agent-send]')!.click();
      expect(pageSend).toHaveBeenCalledTimes(1);
      guard.stop(); newButton.remove();
    } finally { guard.stop(); dom.cleanup(); }
  });

  it('honors native disabled state while idle and clears copied inline handlers', async () => {
    const dom = buildDocument(); dom.button!.disabled = true;
    dom.button!.setAttribute('onclick', 'throw new Error("native inline handler was copied")');
    const guard = createPromptSendGuard(); guard.start();
    try {
      const clone = document.querySelector<HTMLButtonElement>('[data-dpp-agent-send]')!;
      expect(clone.disabled).toBe(true); expect(clone.hasAttribute('onclick')).toBe(false);
      dom.button!.disabled = false;
      await vi.waitFor(() => expect(clone.disabled).toBe(false));
    } finally { guard.stop(); dom.cleanup(); }
  });

  it('restarts document ownership without retaining a stale run claim', () => {
    const dom = buildDocument(); const guard = createPromptSendGuard(); guard.start();
    guard.claim({ onSubmit: () => true }); guard.stop(); guard.start();
    try {
      expect(document.querySelectorAll('[data-dpp-agent-send]')).toHaveLength(1);
      const next = guard.claim({ onSubmit: () => true }); next.dispose();
      expect(dom.button!.style.display).toBe('none');
    } finally { guard.stop(); dom.cleanup(); }
  });
});

it('uses the same clone for queueing text and stopping the active agent', () => {
  const dom = buildDocument(); const guard = createPromptSendGuard(); guard.start();
  const onSubmit = vi.fn(() => true); const onStop = vi.fn(); const pageSend = vi.fn();
  dom.button!.addEventListener('click', pageSend);
  const claim = guard.claim({ onSubmit, onStop, sendLabel: 'Queue', stopLabel: 'Stop agent' });
  try {
    const clone = document.querySelector<HTMLElement>('[data-dpp-agent-send]')!;
    expect(clone.getAttribute('aria-label')).toBe('Stop agent');
    expect(clone.querySelector('rect')).not.toBeNull();
    dom.textarea.value = 'additional text'; dom.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clone.getAttribute('aria-label')).toBe('Queue'); clone.click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('additional text');
    expect(onStop).not.toHaveBeenCalled();
    expect(clone.getAttribute('aria-label')).toBe('Stop agent'); clone.click();
    expect(onStop).toHaveBeenCalledOnce(); expect(pageSend).not.toHaveBeenCalled();
    claim.dispose(); expect(dom.button!.style.display).toBe('none');
  } finally { claim.dispose(); guard.stop(); dom.cleanup(); }
});

it('replaces an unlabelled native stop control in the verified composer and can delegate first-turn stop', () => {
  const dom = buildDocument({ withButton: false }); const box = document.createElement('div'); document.body.append(box);
  box.append(dom.textarea);
  const native = document.createElement('div'); native.setAttribute('role', 'button');
  native.className = 'ds-button ds-button--primary ds-button--circle';
  native.innerHTML = '<div class="ds-button__icon"><svg><rect x="3" y="3" width="10" height="10"/></svg></div>';
  box.append(native);
  const nativeStop = vi.fn(); native.addEventListener('click', nativeStop);
  const guard = createPromptSendGuard(document, { findInputBox: () => box }); guard.start();
  const claim = guard.claim({ onSubmit: () => true, onStop: (stopNative) => stopNative(), stopLabel: 'Stop agent' });
  try {
    expect(native.style.display).toBe('none');
    document.querySelector<HTMLElement>('[data-dpp-agent-send]')!.click();
    expect(nativeStop).toHaveBeenCalledOnce();
  } finally { claim.dispose(); guard.stop(); box.remove(); dom.cleanup(); }
});

it('does not rewrite the stop SVG when the control state is unchanged', () => {
  const dom = buildDocument();
  const interception = installPromptSendInterception({ onSubmit: () => true, onStop: () => {} });
  const clone = document.querySelector<HTMLElement>('[data-dpp-agent-send]')!;
  const observer = new MutationObserver(() => {});
  observer.observe(clone, { childList: true, subtree: true });
  try {
    for (let i = 0; i < 100; i++) interception.refresh();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(clone.querySelector('rect')).not.toBeNull();
  } finally { observer.disconnect(); interception.dispose(); dom.cleanup(); }
});

it('ignores a burst of tool-output mutations without scanning or repositioning the composer', async () => {
  const dom = buildDocument(); const onRefresh = vi.fn();
  const interception = installPromptSendInterception({ onSubmit: () => true, onStop: () => {}, onRefresh });
  const output = document.createElement('div'); output.className = 'dpp-tool-block'; document.body.append(output);
  await Promise.resolve(); await Promise.resolve();
  const scans = vi.spyOn(document, 'querySelectorAll'); onRefresh.mockClear();
  try {
    for (let i = 0; i < 100; i++) {
      const row = document.createElement('div'); row.textContent = `result ${i}`; output.append(row);
    }
    await Promise.resolve(); await Promise.resolve();
    expect(scans).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
  } finally { scans.mockRestore(); interception.dispose(); output.remove(); dom.cleanup(); }
});
