import { createPendingInputQueue, type PendingInputQueue, type PendingInputEnqueueResult } from './pending-input';
import { installPromptSendInterception, type PromptSendGuard, type InputSubmitSource } from '../ui/prompt-send-interception';
import { findPromptTextarea, insertTextIntoPromptTextarea } from '../ui/prompt-text-insertion';

export interface PendingInputLabels {
  send: string; steer: string; steering: string; continue: string; stop: string;
  waiting: string; rejected: string; ended: string; remove: string;
}
const DEFAULT_LABELS: PendingInputLabels = {
  send: 'Queue message', steer: 'Steer', steering: 'Next turn', continue: 'Continue', stop: 'Stop',
  waiting: 'Paused. Continue in the same conversation chain.',
  rejected: 'Not queued. Keep the draft and try again.', ended: 'Finishing the task; please wait.', remove: 'Remove',
};
export interface PendingInputSessionDeps {
  readonly onEnqueued?: (result: PendingInputEnqueueResult) => void;
  readonly onIntercept?: (source: InputSubmitSource, accepted: boolean) => void;
  readonly canAccept?: () => boolean;
  readonly onStop?: (stopNative: () => void) => void;
  readonly root?: Document;
  readonly guard?: PromptSendGuard;
  readonly findInputBox?: () => HTMLElement | null;
  readonly now?: () => number;
  readonly labels?: PendingInputLabels;
}
export interface PendingInputSession {
  readonly queue: PendingInputQueue;
  readonly active: () => boolean;
  readonly closeAdmission: () => void;
  readonly setPaused: (paused: boolean) => void;
  readonly dispose: (restoreDraft?: boolean) => void;
}

/** One run owns composer admission and its in-memory queue. Pending cards live
 * outside the React composer; the send control is replaced in its native slot. */
export function startPendingInputSession(deps: PendingInputSessionDeps = {}): PendingInputSession {
  const root = deps.root ?? document;
  const labels = deps.labels ?? DEFAULT_LABELS;
  const queue = createPendingInputQueue(deps.now);
  let disposed = false;
  let accepting = true;
  let paused = false;
  let notice = '';
  const dock = root.createElement('div');
  dock.className = 'dpp-agent-pending-input';
  dock.style.cssText = 'position:fixed;z-index:1000;display:none;flex-direction:column;gap:6px;max-height:240px;overflow:auto;font:13px/1.5 system-ui;color:var(--dpp-ui-text,#333);';
  const status = root.createElement('div'); status.setAttribute('role', 'status');
  const list = root.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  dock.append(list, status);
  root.body.append(dock);
  let observedBox: HTMLElement | null = null;
  const position = () => {
    if (disposed) return;
    if (queue.size() === 0 && !paused && !notice) {
      if (dock.style.display !== 'none') dock.style.display = 'none';
      resizeObserver?.disconnect(); observedBox = null;
      return;
    }
    const box = deps.findInputBox?.() ?? findPromptTextarea(root)?.parentElement ?? null;
    if (observedBox !== box) {
      resizeObserver?.disconnect(); observedBox = box;
      if (box) resizeObserver?.observe(box);
    }
    dock.style.display = box && (queue.size() > 0 || paused || notice) ? 'flex' : 'none';
    if (!box) return;
    const rect = box.getBoundingClientRect();
    dock.style.left = `${rect.left}px`;
    dock.style.width = `${rect.width}px`;
    dock.style.bottom = `${(root.defaultView?.innerHeight ?? 0) - rect.top + 8}px`;
  };
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
  const cardStyle = 'display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--dpp-ui-border,#ddd);border-radius:14px;background:var(--dpp-ui-surface-muted,#f4f4f4);';
  const action = (label: string) => {
    const button = root.createElement('button'); button.type = 'button'; button.textContent = label;
    button.style.cssText = 'flex-shrink:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:4px;border-radius:6px;';
    return button;
  };
  const render = () => {
    if (disposed) return;
    list.replaceChildren();
    for (const entry of queue.list()) {
      const card = root.createElement('div'); card.style.cssText = cardStyle;
      card.setAttribute('data-dpp-pending-message', String(entry.seq));
      const text = root.createElement('span'); text.textContent = entry.text; text.title = entry.text;
      text.style.cssText = 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      const steer = action(entry.delivery === 'steer' ? labels.steering : labels.steer);
      steer.setAttribute('data-dpp-steer', String(entry.seq));
      steer.disabled = !accepting || entry.delivery === 'steer';
      steer.style.opacity = steer.disabled ? '.5' : '1';
      steer.addEventListener('click', () => { if (accepting) queue.promote(entry.seq); });
      const remove = action(''); remove.setAttribute('aria-label', labels.remove); remove.title = labels.remove;
      remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>';
      remove.addEventListener('click', () => queue.remove(entry.seq));
      card.append(text, steer, remove); list.append(card);
    }
    status.replaceChildren();
    status.style.cssText = cardStyle;
    status.hidden = !notice && !paused;
    if (status.hidden) status.style.display = 'none';
    const statusText = root.createElement('span'); statusText.textContent = notice || labels.waiting;
    statusText.style.flex = '1'; status.append(statusText);
    if (paused && accepting) {
      const resume = action(labels.continue);
      resume.addEventListener('click', () => enqueue(labels.continue)); status.append(resume);
    }
    position();
  };
  const enqueue = (text: string): boolean => {
    if (!accepting || deps.canAccept?.() === false) {
      notice = accepting ? labels.rejected : labels.ended; render(); return false;
    }
    notice = '';
    const result = queue.enqueue({ text, delivery: paused ? 'steer' : 'queue' });
    if (!result.ok) { notice = labels.rejected; render(); }
    deps.onEnqueued?.(result);
    return result.ok;
  };
  const interception = installPromptSendInterception({ root, guard: deps.guard, onSubmit: enqueue,
    onStop: deps.onStop, stopLabel: labels.stop,
    sendLabel: labels.send, disabled: () => !accepting, onIntercept: deps.onIntercept, onRefresh: position });
  const unsubscribe = queue.subscribe(render);
  root.defaultView?.addEventListener('resize', position);
  root.addEventListener('scroll', position, true);
  render();
  return {
    queue, active: () => !disposed,
    closeAdmission: () => { accepting = false; interception.refresh(); render(); },
    setPaused: (value) => { paused = value; notice = ''; render(); },
    dispose(restoreDraft = true) {
      if (disposed) return;
      disposed = true;
      unsubscribe(); interception.dispose(); resizeObserver?.disconnect();
      root.defaultView?.removeEventListener('resize', position);
      root.removeEventListener('scroll', position, true); dock.remove();
      if (restoreDraft && queue.size() > 0) {
        const textarea = findPromptTextarea(root);
        const remaining = queue.list().map((entry) => entry.text).join('\n\n');
        if (textarea) {
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
          insertTextIntoPromptTextarea(`${textarea.value ? '\n\n' : ''}${remaining}`, textarea);
        }
      }
      queue.clear();
    },
  };
}
