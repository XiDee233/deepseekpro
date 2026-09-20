import { createPendingInputQueue, type PendingInputQueue, type PendingInputEnqueueResult } from './pending-input';
import { installPromptSendInterception, type PromptSendGuard, type InputSubmitSource } from '../ui/prompt-send-interception';
import { findPromptTextarea, insertTextIntoPromptTextarea } from '../ui/prompt-text-insertion';

export interface PendingInputLabels {
  send: string; steer: string; steering: string; continue: string; stop: string;
  waiting: string; rejected: string; ended: string; remove: string;
  preparing: string; requesting: string; responding: string; stopping: string;
  toolWait: (name: string, count: number) => string;
  elapsed: (seconds: number) => string;
}
export type PendingInputActivity = 'preparing' | 'requesting' | 'responding' | 'stopping' | 'finishing';
const DEFAULT_LABELS: PendingInputLabels = {
  send: 'Queue message', steer: 'Steer', steering: 'Next turn', continue: 'Continue', stop: 'Stop',
  waiting: 'Paused. Continue in the same conversation chain.',
  rejected: 'Not queued. Keep the draft and try again.', ended: 'Finishing the task; please wait.', remove: 'Remove',
  preparing: 'Preparing the next step', requesting: 'Waiting for the model response', responding: 'Receiving the model response',
  stopping: 'Stop requested; waiting for active work to settle',
  toolWait: (name, count) => `Waiting for tool results: ${name}${count > 1 ? ` (+${count - 1})` : ''}`,
  elapsed: (seconds) => `Waiting ${seconds}s`,
};
export interface PendingInputSessionDeps {
  readonly onEnqueued?: (result: PendingInputEnqueueResult) => void;
  readonly onIntercept?: (source: InputSubmitSource, accepted: boolean) => void;
  readonly canAccept?: () => boolean;
  readonly onStop?: (stopNative: () => void) => void;
  readonly root?: Document;
  readonly guard?: PromptSendGuard;
  readonly findInputBox?: () => HTMLElement | null;
  readonly findActivityAnchor?: () => HTMLElement | null;
  readonly isVisible?: () => boolean;
  readonly now?: () => number;
  readonly labels?: PendingInputLabels;
}
export interface PendingInputSession {
  readonly queue: PendingInputQueue;
  readonly active: () => boolean;
  readonly closeAdmission: () => void;
  readonly setPaused: (paused: boolean) => void;
  readonly setActivity: (phase: PendingInputActivity) => void;
  readonly trackTool: (id: string, name: string) => () => void;
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
  const now = deps.now ?? Date.now;
  let phase: PendingInputActivity = 'preparing';
  let phaseSince = now();
  const pendingTools = new Map<string, { name: string; since: number }>();
  const dock = root.createElement('div');
  dock.className = 'dpp-agent-pending-input';
  dock.style.cssText = 'display:none;box-sizing:border-box;width:100%;flex-direction:column;gap:6px;max-height:280px;margin-bottom:8px;font:13px/1.5 system-ui;color:var(--dpp-ui-text,#333);';
  const status = root.createElement('div'); status.setAttribute('role', 'status');
  const activity = root.createElement('div'); activity.setAttribute('data-dpp-task-activity', 'true');
  activity.className = 'dpp-token-speed-badge';
  activity.style.cssText = 'max-width:380px;min-width:0;gap:6px;';
  const activityText = root.createElement('span'); activityText.setAttribute('role', 'status');
  activityText.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const activityTime = root.createElement('span'); activityTime.setAttribute('aria-hidden', 'true');
  activityTime.style.cssText = 'flex-shrink:0;font-variant-numeric:tabular-nums;';
  activity.append(activityText, activityTime);
  const list = root.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;';
  dock.append(list, status);
  root.body.append(dock);
  const position = () => {
    if (disposed) return;
    if (deps.isVisible?.() === false || (queue.size() === 0 && !paused && !notice)) {
      if (dock.style.display !== 'none') dock.style.display = 'none';
      return;
    }
    const box = deps.findInputBox?.() ?? findPromptTextarea(root)?.parentElement ?? null;
    dock.style.display = box ? 'flex' : 'none';
    if (!box) return;
    // Sibling of the composer, in normal flow. Queue cards occupy real space
    // rather than a fixed overlay over the last answer and its action row.
    if (dock.parentElement !== box.parentElement || dock.nextSibling !== box) box.before(dock);
  };
  const renderActivity = () => {
    if (disposed) return;
    const anchor = deps.isVisible?.() === false ? null : deps.findActivityAnchor?.() ?? null;
    if (anchor?.isConnected) {
      const appearance = anchor.getAttribute('data-active');
      if (activity.getAttribute('data-active') !== appearance) {
        if (appearance === null) activity.removeAttribute('data-active');
        else activity.setAttribute('data-active', appearance);
      }
      if (anchor.nextSibling !== activity) anchor.after(activity);
    } else activity.remove();
    const first = pendingTools.values().next().value;
    const names = [...new Set([...pendingTools.values()].map((tool) => tool.name))].slice(0, 3).join(' / ');
    const toolText = first ? labels.toolWait(names, pendingTools.size) : '';
    const text = phase === 'stopping' ? `${labels.stopping}${toolText ? ` · ${toolText}` : ''}`
      : toolText || (paused ? labels.waiting : phase === 'finishing' ? labels.ended : labels[phase]);
    if (activityText.textContent !== text) activityText.textContent = text;
    if (activityText.title !== text) activityText.title = text;
    const elapsed = labels.elapsed(Math.max(0, Math.floor((now() - (first?.since ?? phaseSince)) / 1000)));
    if (activityTime.textContent !== elapsed) activityTime.textContent = elapsed;
    const activityPhase = phase === 'stopping' ? 'stopping' : first ? 'waiting_tool' : paused ? 'paused' : phase;
    if (activity.getAttribute('data-phase') !== activityPhase) activity.setAttribute('data-phase', activityPhase);
  };
  // Share the badge surface while keeping message-sized text, spacing and
  // interactive controls (the compact statistics badge itself is noninteractive).
  const cardStyle = 'display:flex;box-sizing:border-box;width:100%;max-width:none;flex:0 0 auto;align-items:center;justify-content:flex-start;gap:12px;margin-left:0;padding:10px 14px;font:inherit;pointer-events:auto;';
  const action = (label: string) => {
    const button = root.createElement('button'); button.type = 'button'; button.textContent = label;
    button.style.cssText = 'flex-shrink:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:4px;border-radius:6px;';
    return button;
  };
  const render = () => {
    if (disposed) return;
    list.replaceChildren();
    for (const entry of queue.list()) {
      const card = root.createElement('div'); card.className = 'dpp-token-speed-badge'; card.style.cssText = cardStyle;
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
    status.className = 'dpp-token-speed-badge';
    status.style.cssText = cardStyle;
    status.hidden = !notice && !paused;
    if (status.hidden) status.style.display = 'none';
    const statusText = root.createElement('span'); statusText.textContent = notice || labels.waiting;
    statusText.style.flex = '1'; status.append(statusText);
    if (paused && accepting) {
      const resume = action(labels.continue);
      resume.addEventListener('click', () => enqueue(labels.continue)); status.append(resume);
    }
    renderActivity();
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
  root.defaultView?.addEventListener('dpp:navigation', position);
  // Only update the two status text nodes, never rebuild cards or measure the
  // composer on each tick. Elapsed time is waiting time, not host liveness.
  const activityTimer = root.defaultView?.setInterval(renderActivity, 1000);
  render();
  return {
    queue, active: () => !disposed,
    closeAdmission: () => { accepting = false; if (phase !== 'stopping') phase = 'finishing'; interception.refresh(); render(); },
    setPaused: (value) => { paused = value; notice = ''; render(); },
    setActivity: (value) => {
      if (disposed || phase === 'stopping' || phase === value) return;
      phase = value; phaseSince = now(); renderActivity();
    },
    trackTool: (id, name) => {
      if (!disposed && !pendingTools.has(id)) { pendingTools.set(id, { name, since: now() }); renderActivity(); }
      return () => { if (!disposed && pendingTools.delete(id)) { phaseSince = now(); renderActivity(); } };
    },
    dispose(restoreDraft = true) {
      if (disposed) return;
      disposed = true;
      unsubscribe(); interception.dispose();
      if (activityTimer !== undefined) root.defaultView?.clearInterval(activityTimer);
      pendingTools.clear();
      root.defaultView?.removeEventListener('dpp:navigation', position);
      dock.remove();
      activity.remove();
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
