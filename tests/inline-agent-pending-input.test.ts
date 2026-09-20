import { describe, expect, it } from 'vitest';
import {
  createPendingInputQueue,
  PENDING_INPUT_MAX_ITEMS,
  PENDING_INPUT_MAX_ITEM_CHARS,
} from '../core/inline-agent/pending-input';

describe('pending input queue', () => {
  it('admits a trimmed entry with a monotonic seq and defaults to steer', () => {
    const queue = createPendingInputQueue(() => 1000);
    const first = queue.enqueue({ text: '  change the output to JSON  ' });
    const second = queue.enqueue({ text: 'and run the tests', delivery: 'queue' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.entry.text).toBe('change the output to JSON');
    expect(first.entry.delivery).toBe('steer');
    expect(first.entry.seq).toBe(1);
    expect(first.entry.admittedAt).toBe(1000);
    expect(first.entry.refFileIds).toEqual([]);
    expect(second.entry.seq).toBe(2);
    expect(second.entry.delivery).toBe('queue');
    expect(queue.size()).toBe(2);
  });

  it('copies ref file ids instead of aliasing caller state', () => {
    const queue = createPendingInputQueue();
    const refFileIds = ['file-1'];
    const result = queue.enqueue({ text: 'look at this', refFileIds });
    refFileIds.push('file-2');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.refFileIds).toEqual(['file-1']);
  });

  it('rejects empty, oversized, and over-capacity input', () => {
    const queue = createPendingInputQueue();

    expect(queue.enqueue({ text: '   ' })).toEqual({ ok: false, reason: 'empty_text' });
    expect(queue.enqueue({
      text: 'x'.repeat(PENDING_INPUT_MAX_ITEM_CHARS + 1),
    })).toEqual({ ok: false, reason: 'item_too_long' });

    for (let i = 0; i < PENDING_INPUT_MAX_ITEMS; i += 1) {
      expect(queue.enqueue({ text: `message ${i}` }).ok).toBe(true);
    }
    expect(queue.enqueue({ text: 'one too many' })).toEqual({
      ok: false,
      reason: 'queue_full',
    });
  });

  it('enforces the aggregate character budget', () => {
    const queue = createPendingInputQueue();
    const chunk = 'y'.repeat(PENDING_INPUT_MAX_ITEM_CHARS);

    expect(queue.enqueue({ text: chunk }).ok).toBe(true);
    expect(queue.enqueue({ text: chunk }).ok).toBe(true);
    expect(queue.enqueue({ text: chunk }).ok).toBe(true);
    // 3 * 4000 = 12000, so the next one must be rejected by the total budget.
    expect(queue.enqueue({ text: 'z' })).toEqual({
      ok: false,
      reason: 'total_too_long',
    });
    expect(queue.totalChars()).toBe(12000);
  });

  it('drains each delivery independently and preserves admission order', () => {
    const queue = createPendingInputQueue();
    queue.enqueue({ text: 'steer one' });
    queue.enqueue({ text: 'queue one', delivery: 'queue' });
    queue.enqueue({ text: 'steer two' });
    queue.enqueue({ text: 'queue two', delivery: 'queue' });

    const steers = queue.drainSteers();
    expect(steers.map((entry) => entry.text)).toEqual(['steer one', 'steer two']);
    expect(queue.size()).toBe(2);

    const queued = queue.drainQueued();
    expect(queued.map((entry) => entry.text)).toEqual(['queue one', 'queue two']);
    expect(queue.size()).toBe(0);
    expect(queue.drainSteers()).toEqual([]);
  });

  it('removes a single entry by seq and reports misses', () => {
    const queue = createPendingInputQueue();
    const first = queue.enqueue({ text: 'keep' });
    const second = queue.enqueue({ text: 'drop' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(queue.remove(second.entry.seq)).toBe(true);
    expect(queue.list().map((entry) => entry.text)).toEqual(['keep']);
    expect(queue.remove(second.entry.seq)).toBe(false);
  });

  it('clears every entry and allows reuse afterwards', () => {
    const queue = createPendingInputQueue();
    queue.enqueue({ text: 'a' });
    queue.enqueue({ text: 'b' });

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.list()).toEqual([]);

    const reused = queue.enqueue({ text: 'c' });
    expect(reused.ok).toBe(true);
    if (!reused.ok) return;
    expect(reused.entry.seq).toBe(3);
  });

  it('returns a fresh snapshot array on every list call', () => {
    const queue = createPendingInputQueue();
    queue.enqueue({ text: 'snapshot' });

    const first = queue.list();
    const second = queue.list();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(queue.size()).toBe(1);
  });
});


describe('pending input pause and recovery', () => {
  it('waits for an explicit steer at a budget pause, not an existing after-task item', async () => {
    const queue = createPendingInputQueue();
    queue.enqueue({ text: 'later', delivery: 'queue' });
    const abort = new AbortController();
    let awake = false;
    const wait = queue.waitForInput(abort.signal, 'steer').then((result) => { awake = result; });
    await Promise.resolve(); expect(awake).toBe(false);
    queue.enqueue({ text: 'continue', delivery: 'steer' });
    await wait; expect(awake).toBe(true);
  });

  it('abort releases a paused waiter without consuming input', async () => {
    const queue = createPendingInputQueue(); const abort = new AbortController();
    const wait = queue.waitForInput(abort.signal); abort.abort();
    expect(await wait).toBe(false);
    expect(queue.size()).toBe(0);
  });

  it('restores failed input ahead of new entries without duplicating sequence ids', () => {
    const queue = createPendingInputQueue();
    queue.enqueue({ text: 'first' }); const batch = queue.drainSteers();
    queue.enqueue({ text: 'second' });
    queue.restore(batch); queue.restore(batch);
    expect(queue.list().map((entry) => entry.text)).toEqual(['first', 'second']);
  });
});
