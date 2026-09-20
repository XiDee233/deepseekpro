/**
 * Mid-conversation pending input queue.
 *
 * Users can send messages while an inline agent loop is running. Instead of
 * dropping them (the pre-existing concurrency guard behavior) or letting the
 * page fire an uncontrolled native request, those messages are held here and
 * promoted at a safe provider-turn boundary by the pi loop adapter.
 *
 * Delivery semantics mirror the upstream pi-agent-core hooks:
 *  - `steer` -> drained by `getSteeringMessages` at the next turn boundary.
 *  - `queue` -> drained by `getFollowUpMessages` once the agent would stop.
 *
 * This module is intentionally pure: no DOM, no chrome APIs, no logging. It
 * holds bounded in-memory state so a runaway queue cannot exhaust memory or
 * blow up the model-facing context.
 */

export type PendingInputDelivery = 'steer' | 'queue';

export interface PendingInput {
  readonly seq: number;
  readonly text: string;
  readonly refFileIds: readonly string[];
  readonly delivery: PendingInputDelivery;
  readonly admittedAt: number;
}

export const PENDING_INPUT_MAX_ITEMS = 5;
export const PENDING_INPUT_MAX_ITEM_CHARS = 4000;
export const PENDING_INPUT_MAX_TOTAL_CHARS = 12000;

export type PendingInputRejectionReason =
  | 'empty_text'
  | 'item_too_long'
  | 'queue_full'
  | 'total_too_long';

export type PendingInputEnqueueResult =
  | { readonly ok: true; readonly entry: PendingInput }
  | { readonly ok: false; readonly reason: PendingInputRejectionReason };

export interface PendingInputEnqueueRequest {
  readonly text: string;
  readonly refFileIds?: readonly string[];
  readonly delivery?: PendingInputDelivery;
}

export interface PendingInputQueue {
  readonly enqueue: (request: PendingInputEnqueueRequest) => PendingInputEnqueueResult;
  readonly list: () => readonly PendingInput[];
  readonly size: () => number;
  readonly totalChars: () => number;
  readonly drainSteers: () => readonly PendingInput[];
  readonly drainQueued: () => readonly PendingInput[];
  readonly restore: (entries: readonly PendingInput[]) => void;
  readonly promote: (seq: number) => boolean;
  readonly remove: (seq: number) => boolean;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly waitForInput: (signal: AbortSignal, delivery?: PendingInputDelivery) => Promise<boolean>;
}

function countChars(entries: readonly PendingInput[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

export function createPendingInputQueue(
  now: () => number = Date.now,
): PendingInputQueue {
  let entries: PendingInput[] = [];
  let nextSeq = 1;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };

  const enqueue = (
    request: PendingInputEnqueueRequest,
  ): PendingInputEnqueueResult => {
    const text = request.text.trim();
    if (!text) return { ok: false, reason: 'empty_text' };
    if (text.length > PENDING_INPUT_MAX_ITEM_CHARS) {
      return { ok: false, reason: 'item_too_long' };
    }
    if (entries.length >= PENDING_INPUT_MAX_ITEMS) {
      return { ok: false, reason: 'queue_full' };
    }
    if (countChars(entries) + text.length > PENDING_INPUT_MAX_TOTAL_CHARS) {
      return { ok: false, reason: 'total_too_long' };
    }

    const entry: PendingInput = {
      seq: nextSeq++,
      text,
      refFileIds: [...(request.refFileIds ?? [])],
      delivery: request.delivery ?? 'steer',
      admittedAt: now(),
    };
    entries = [...entries, entry];
    notify();
    return { ok: true, entry };
  };

  const drainByDelivery = (
    delivery: PendingInputDelivery,
  ): readonly PendingInput[] => {
    const drained = entries.filter((entry) => entry.delivery === delivery);
    if (drained.length === 0) return [];
    entries = entries.filter((entry) => entry.delivery !== delivery);
    notify();
    return drained;
  };

  return {
    enqueue,
    list: () => [...entries],
    size: () => entries.length,
    totalChars: () => countChars(entries),
    drainSteers: () => drainByDelivery('steer'),
    drainQueued: () => drainByDelivery('queue'),
    restore: (failed) => {
      const queuedSeqs = new Set(entries.map((entry) => entry.seq));
      entries = [...failed.filter((entry) => !queuedSeqs.has(entry.seq)), ...entries];
      notify();
    },
    promote: (seq) => {
      const entry = entries.find((item) => item.seq === seq);
      if (!entry) return false;
      entries = entries.map((item) => item.seq === seq ? { ...item, delivery: 'steer' as const } : item);
      notify();
      return true;
    },
    remove: (seq) => {
      const next = entries.filter((entry) => entry.seq !== seq);
      if (next.length === entries.length) return false;
      entries = next;
      notify();
      return true;
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    waitForInput: (signal, delivery) => {
      const available = () => entries.some((entry) => !delivery || entry.delivery === delivery);
      if (signal.aborted) return Promise.resolve(false);
      if (available()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const settle = (value: boolean) => {
          listeners.delete(changed);
          signal.removeEventListener('abort', aborted);
          resolve(value);
        };
        const changed = () => { if (available()) settle(true); };
        const aborted = () => settle(false);
        listeners.add(changed);
        signal.addEventListener('abort', aborted, { once: true });
      });
    },
    clear: () => {
      entries = [];
      notify();
    },
  };
}
