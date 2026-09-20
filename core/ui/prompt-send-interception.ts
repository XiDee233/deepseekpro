import { findPromptTextarea } from './prompt-text-insertion';

export const NATIVE_SEND_SELECTORS = [
  'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]',
  'div[role="button"][aria-label="Send"]', 'div[role="button"][aria-label="发送"]',
  '[role="button"].ds-button--primary.ds-button--circle',
] as const;
const NATIVE_STOP_SELECTORS = ['button[aria-label="Stop"]', 'button[aria-label="停止"]',
  '[role="button"][aria-label="Stop generating"]', '[role="button"][aria-label="停止生成"]'] as const;
const COMPOSER_CONTROL_SELECTOR = [...NATIVE_SEND_SELECTORS, ...NATIVE_STOP_SELECTORS].join(',');
const SEND_ARROW_PREFIX = 'M8.3125 0.980206';
export const SEND_HIDDEN_ATTRIBUTE = 'data-dpp-send-hidden';
export type InputSubmitSource = 'keyboard' | 'button' | 'form';
export interface ComposerEnterEvent {
  readonly key: string; readonly shiftKey: boolean;
  readonly isComposing?: boolean; readonly keyCode?: number;
}
export function shouldInterceptComposerEnter(event: ComposerEnterEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
export function readComposerSubmission(value: string): string | null { return value.trim() || null; }
export interface PromptSendInterception {
  readonly dispose: () => void;
  readonly refresh: () => void;
  readonly submit: () => boolean;
}
export interface PromptSendInterceptionDeps {
  readonly onSubmit: (text: string) => boolean;
  readonly onIntercept?: (source: InputSubmitSource, accepted: boolean) => void;
  readonly root?: Document;
  readonly findTextarea?: (root: ParentNode) => HTMLTextAreaElement | null;
  readonly guard?: PromptSendGuard;
  readonly sendLabel?: string;
  readonly disabled?: () => boolean;
  readonly onRefresh?: () => void;
  readonly onStop?: (stopNative: () => void) => void;
  readonly stopLabel?: string;
}
export interface PromptSendGuardOptions {
  readonly onReplacement?: (count: number, added: number, removed: number) => void;
  readonly onRoute?: (source: InputSubmitSource, route: 'native' | 'queue' | 'blocked' | 'stop') => void;
  readonly findInputBox?: () => HTMLElement | null;
}
export interface PromptSendGuard {
  start(): void;
  stop(): void;
  claim(deps: PromptSendInterceptionDeps): PromptSendInterception;
}
function isNativeSend(element: Element): boolean {
  return NATIVE_SEND_SELECTORS.some((selector, index) => element.matches(selector)
    && (index < NATIVE_SEND_SELECTORS.length - 1
      || Boolean(element.querySelector('svg path')?.getAttribute('d')?.startsWith(SEND_ARROW_PREFIX))));
}
interface Replacement {
  button: HTMLElement;
  display: string;
  priority: string;
  inert: boolean;
  nativeMarkup: string;
  nativeHTML: string;
  renderKey: string;
}

function cloneVisual(native: HTMLElement): HTMLElement {
  const clone = native.cloneNode(true) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('on') || attribute.name === 'id') element.removeAttribute(attribute.name);
    }
  }
  return clone;
}

/** Document lifetime owns the clone and hidden original. Runs only claim and
 * release delivery; releasing a run never restores the official send button. */
export function createPromptSendGuard(root: Document = document, options: PromptSendGuardOptions = {}): PromptSendGuard {
  const eventRoot: EventTarget = root.defaultView ?? root;
  const replacements = new Map<HTMLElement, Replacement>();
  let active: { token: symbol; deps: PromptSendInterceptionDeps } | null = null;
  let started = false;
  let swallowedEnter = false;
  let forwardedClick: HTMLElement | null = null;
  const textarea = () => (active?.deps.findTextarea ?? findPromptTextarea)(root);
  const isControl = (element: HTMLElement) => isNativeSend(element)
    || NATIVE_STOP_SELECTORS.some((selector) => element.matches(selector))
    || (element.matches('[role="button"].ds-button--primary.ds-button--circle')
      && (replacements.has(element) || Boolean(options.findInputBox?.()?.contains(element))));
  const wantsStop = () => Boolean(active?.deps.onStop && !textarea()?.value.trim());
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const style = root.createElement('style');
  const selectors = NATIVE_SEND_SELECTORS.map((selector, index) =>
    `${selector}:not([data-dpp-agent-send])${index === NATIVE_SEND_SELECTORS.length - 1
      ? `:has(svg path[d^="${SEND_ARROW_PREFIX}"])` : ''}`);
  // Applies before the observer runs when React creates a new native node.
  style.textContent = `${[...selectors, ...NATIVE_STOP_SELECTORS.map((selector) => `${selector}:not([data-dpp-agent-send])`)].join(',')}, [${SEND_HIDDEN_ATTRIBUTE}="true"]
    { display:none !important; pointer-events:none !important; }
    [data-dpp-agent-send][aria-disabled="false"] { pointer-events:auto !important; cursor:pointer; }`;
  const restore = (native: HTMLElement, saved: Replacement) => {
    native.style.setProperty('display', saved.display, saved.priority);
    native.inert = saved.inert;
    native.removeAttribute(SEND_HIDDEN_ATTRIBUTE);
    saved.button.remove();
  };
  const refresh = () => {
    if (!started) return;
    if (!style.isConnected) (root.head ?? root.documentElement)?.append(style);
    let added = 0; let removed = 0;
    for (const [native, saved] of replacements) {
      if (!native.isConnected || !isControl(native)) {
        restore(native, saved); replacements.delete(native); removed++;
      }
    }
    for (const native of root.querySelectorAll<HTMLElement>(COMPOSER_CONTROL_SELECTOR)) {
      if (native.hasAttribute('data-dpp-agent-send') || !isControl(native)) continue;
      let saved = replacements.get(native);
      if (!saved && (native.style.display === 'none' || native.style.visibility === 'hidden')) continue;
      if (!saved) {
        // Cloning retains the site's appearance, not React/addEventListener handlers.
        const button = cloneVisual(native);
        if (button instanceof HTMLButtonElement) button.type = 'button';
        button.setAttribute('data-dpp-agent-send', 'true');
        saved = { button, display: native.style.display, priority: native.style.getPropertyPriority('display'), inert: native.inert,
          nativeMarkup: button.innerHTML, nativeHTML: native.innerHTML, renderKey: '' };
        replacements.set(native, saved); added++;
      }
      if (native.getAttribute(SEND_HIDDEN_ATTRIBUTE) !== 'true') native.setAttribute(SEND_HIDDEN_ATTRIBUTE, 'true');
      if (native.style.display !== 'none' || native.style.getPropertyPriority('display') !== 'important') native.style.setProperty('display', 'none', 'important');
      if (!native.inert) native.inert = true;
      if (saved.button.className !== native.className) saved.button.className = native.className;
      if (saved.nativeHTML !== native.innerHTML) {
        saved.nativeHTML = native.innerHTML;
        saved.nativeMarkup = cloneVisual(native).innerHTML;
      }
      const mode = active?.deps.onStop && (wantsStop() || !isNativeSend(native))
        ? wantsStop() ? 'stop' : 'send' : 'native';
      const renderKey = mode === 'native' ? `native:${saved.nativeMarkup}` : mode;
      // innerHTML normalizes SVG self-closing tags. Compare our render state,
      // never markup source against the browser's serialized markup.
      if (saved.renderKey !== renderKey) {
        if (mode === 'native') saved.button.innerHTML = saved.nativeMarkup;
        else {
        const markup = mode === 'stop'
          ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 14V2m-5 5 5-5 5 5" stroke="currentColor" stroke-width="2"/></svg>';
        const target = saved.button.querySelector('.ds-button__icon') ?? saved.button;
        target.innerHTML = markup;
        }
        saved.renderKey = renderKey;
      }
      if (saved.button.parentElement !== native.parentElement || saved.button.nextSibling !== native) native.before(saved.button);
      const disabled = active ? active.deps.disabled?.() ?? false
        : native.hasAttribute('disabled') || native.getAttribute('aria-disabled') === 'true';
      if (saved.button instanceof HTMLButtonElement && saved.button.disabled !== disabled) saved.button.disabled = disabled;
      if (saved.button.getAttribute('aria-disabled') !== String(disabled)) saved.button.setAttribute('aria-disabled', String(disabled));
      if (saved.button.tabIndex !== (disabled ? -1 : 0)) saved.button.tabIndex = disabled ? -1 : 0;
      const label = (wantsStop() ? active?.deps.stopLabel : active?.deps.sendLabel) ?? native.getAttribute('aria-label');
      if (label !== saved.button.getAttribute('aria-label')) {
        if (label) saved.button.setAttribute('aria-label', label); else saved.button.removeAttribute('aria-label');
      }
    }
    if (added || removed) {
      options.onReplacement?.(replacements.size, added, removed);
      active?.deps.onRefresh?.();
    }
  };
  const ownsNode = (node: Node) => node instanceof Element
    && Boolean(node.closest('[data-dpp-agent-send], .dpp-agent-pending-input'));
  const containsControl = (node: Node) => node instanceof Element && !ownsNode(node)
    && (node.matches(`${COMPOSER_CONTROL_SELECTOR},textarea`)
      || Boolean(node.querySelector(`${COMPOSER_CONTROL_SELECTOR},textarea`)));
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => {
      if (ownsNode(mutation.target)) return false;
      const target = mutation.target instanceof Element ? mutation.target : null;
      // Tool output and assistant streaming are unrelated to the composer.
      if (target?.closest('.ds-message, .dpp-agent-container, .dpp-tool-block, .dpp-artifact-results')) return false;
      if (target?.closest(`[${SEND_HIDDEN_ATTRIBUTE}]`)) return true;
      if (mutation.type === 'attributes') return Boolean(target?.closest(COMPOSER_CONTROL_SELECTOR));
      if (mutation.type !== 'childList') return false;
      if ([...mutation.addedNodes, ...mutation.removedNodes].some(containsControl)) return true;
      return [...mutation.removedNodes].some((node) => node === style
        || [...replacements].some(([native, saved]) => saved.button === node && native.isConnected));
    })) refresh();
  });
  const submit = (source: InputSubmitSource, clicked?: HTMLElement): boolean => {
    const owner = active;
    if (!owner) {
      const native = [...replacements].find(([original, saved]) => clicked
        ? original === clicked || saved.button === clicked : original.isConnected)?.[0];
      if (!native || native.hasAttribute('disabled') || native.getAttribute('aria-disabled') === 'true') {
        options.onRoute?.(source, 'blocked'); return false;
      }
      // Only this synchronous click may reach the site's native handler. The
      // original remains hidden/inert throughout; no simulated input or network path.
      forwardedClick = native;
      try { native.click(); } finally { forwardedClick = null; }
      options.onRoute?.(source, 'native');
      return true;
    }
    const input = textarea();
    const text = input ? readComposerSubmission(input.value) : null;
    const accepted = Boolean(input && text !== null && !owner.deps.disabled?.() && owner.deps.onSubmit(text));
    owner.deps.onIntercept?.(source, accepted);
    options.onRoute?.(source, accepted ? 'queue' : 'blocked');
    if (!accepted || !input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const stopOrSubmit = (source: InputSubmitSource, clicked?: HTMLElement) => {
    if (!wantsStop()) return submit(source, clicked);
    const owner = active!;
    if (owner.deps.disabled?.()) { options.onRoute?.(source, 'blocked'); return false; }
    owner.deps.onStop!(() => {
      const native = [...replacements.keys()].find((control) => !isNativeSend(control));
      if (!native) return;
      forwardedClick = native;
      try { native.click(); } finally { forwardedClick = null; }
    });
    options.onRoute?.(source, 'stop');
    return true;
  };
  const sendButton = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const button = target.closest<HTMLElement>('button, [role="button"]');
    return button && (button.hasAttribute('data-dpp-agent-send') || isControl(button)) ? button : null;
  };
  const keydown = (event: Event) => {
    const key = event as KeyboardEvent;
    const button = sendButton(event.target);
    // Ordinary idle keyboard behavior stays native (including site shortcuts).
    if ((active && event.target === textarea() && shouldInterceptComposerEnter(key))
      || (button && !key.isComposing && (key.key === 'Enter' || key.key === ' '))) {
      block(event); swallowedEnter = true;
      if (button) stopOrSubmit('keyboard', button); else submit('keyboard');
    }
  };
  const keyTail = (event: Event) => {
    const key = event as KeyboardEvent;
    if (!swallowedEnter || (key.key !== 'Enter' && key.key !== ' ')) return;
    block(event);
    if (event.type === 'keyup') swallowedEnter = false;
  };
  const pointer = (event: Event) => {
    const button = sendButton(event.target);
    if (!button || (event.type === 'click' && !event.isTrusted && event.target === forwardedClick)) return;
    block(event);
    if (event.type === 'click') { refresh(); stopOrSubmit('button', button); }
  };
  const formSubmit = (event: Event) => {
    if (!active) return;
    const input = textarea();
    if (input && event.target instanceof Element && event.target.contains(input)) { block(event); submit('form'); }
  };
  const listeners: Array<[string, EventListener]> = [
    ['input', (event) => { if (event.target === textarea()) refresh(); }],
    ['keydown', keydown], ['keypress', keyTail], ['keyup', keyTail],
    ...['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'].map(
      (name): [string, EventListener] => [name, pointer]), ['submit', formSubmit],
  ];
  return {
    start() {
      if (started) return;
      started = true;
      for (const [name, listener] of listeners) eventRoot.addEventListener(name, listener, { capture: true, passive: false });
      // Document itself exists even before documentElement at document_start.
      observer.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'd', 'aria-label', 'aria-disabled', 'disabled', SEND_HIDDEN_ATTRIBUTE] });
      refresh();
    },
    stop() {
      if (!started) return;
      started = false;
      observer.disconnect();
      for (const [name, listener] of listeners) eventRoot.removeEventListener(name, listener, true);
      active = null; swallowedEnter = false;
      for (const [native, saved] of replacements) restore(native, saved);
      replacements.clear(); style.remove();
    },
    claim(deps) {
      if (active) throw new Error('The composer already belongs to another agent run.');
      if (!started) throw new Error('The document-start input guard is not running.');
      const token = Symbol('agent-input-owner'); active = { token, deps }; refresh();
      return {
        refresh,
        submit: () => active?.token === token && submit('button'),
        dispose() { if (active?.token === token) { active = null; refresh(); } },
      };
    },
  };
}

/** Standalone tests own the document guard. Production only claims the guard
 * already started by the content lifecycle, and never tears down its buttons. */
export function installPromptSendInterception(deps: PromptSendInterceptionDeps): PromptSendInterception {
  const guard = deps.guard ?? createPromptSendGuard(deps.root);
  if (!deps.guard) guard.start();
  const claim = guard.claim(deps);
  return { ...claim, dispose() { claim.dispose(); if (!deps.guard) guard.stop(); } };
}
