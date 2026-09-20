import { describe, expect, it } from 'vitest';
import {
  elementHasMessageId, readAssistantMessageIdentity, resolveInlineAgentTarget,
  placeInlineAgentContainer, isAssistantMessageIdentityMutation,
} from '../core/inline-agent/message-anchor';

function message(id?: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'ds-message';
  if (id) element.setAttribute('data-message-id', id);
  element.innerHTML = '<div class="ds-markdown">The same answer text.</div>';
  return element;
}
function row(id: string): { row: HTMLElement; message: HTMLElement } {
  const owner = document.createElement('div');
  owner.setAttribute('data-virtual-list-item-key', id);
  const node = message();
  owner.append(node);
  return { row: owner, message: node };
}
const resolve = (id: number, messages: Element[]) => resolveInlineAgentTarget(id, messages, new Set());

describe('native assistant message identity', () => {
  it('reads identity only on the message envelope or its owning native row', () => {
    expect(readAssistantMessageIdentity(message('42'))).toEqual({ id: '42', source: 'message_attribute' });
    expect(readAssistantMessageIdentity(row('18').message)).toEqual({ id: '18', source: 'virtual_item_key' });
    const named = message();
    named.id = 'ds-message-42';
    expect(elementHasMessageId(named, '42')).toBe(true);
    expect(elementHasMessageId(named, '2')).toBe(false);
  });

  it('does not mistake the screenshot Mermaid node ids for an earlier message', () => {
    const final = row('18').message;
    final.querySelector('.ds-markdown')!.innerHTML = `
      <h2>Final answer</h2><svg id="mermaid-svg-0">
        <g id="flowchart-WB1-12"></g><g id="flowchart-WB3-14"></g>
        <g id="flowchart-WB6-17"></g></svg>`;
    for (const id of [12, 14, 17]) {
      expect(elementHasMessageId(final, String(id))).toBe(false);
      expect(resolve(id, [final])).toMatchObject({ target: null, reason: 'anchor_missing' });
    }
    expect(resolve(18, [final]).target).toBe(final);
  });

  it('ignores explicit-looking ids inside generated content and injected UI', () => {
    const node = message();
    node.querySelector('.ds-markdown')!.innerHTML = `
      <div id="ds-message-12" data-message-id="12"></div>
      <div class="dpp-agent-container" data-id="12"></div>`;
    expect(resolve(12, [node]).target).toBeNull();
  });

  it('rejects conflicting identity and wrappers owning multiple messages', () => {
    const conflict = row('18');
    conflict.message.setAttribute('data-message-id', '12');
    expect(readAssistantMessageIdentity(conflict.message)).toBeNull();
    const shared = row('18');
    shared.row.append(message());
    expect(readAssistantMessageIdentity(shared.message)).toBeNull();
  });

  it('does not use matching text, DOM order or a virtual window index', () => {
    const newer = row('18').message;
    expect(resolve(12, [newer])).toMatchObject({ target: null, reason: 'anchor_missing' });
    const correct = row('12').message;
    expect(resolve(12, [newer, correct]).target).toBe(correct);
    expect(resolve(12, [correct, newer]).target).toBe(correct);
  });

  it('refuses ambiguous and already claimed identities', () => {
    const a = message('12'); const b = message('12');
    expect(resolve(12, [a, b])).toMatchObject({ reason: 'anchor_ambiguous', target: null, candidateCount: 2 });
    expect(resolveInlineAgentTarget(12, [a], new Set([a]))).toMatchObject({ reason: 'anchor_claimed', target: null });
  });
});

describe('shared live/restore placement', () => {
  it('places either presentation at the trigger, never below the final answer', () => {
    const trigger = row('12'); const final = row('18');
    for (const restored of [false, true]) {
      const panel = document.createElement('div'); panel.className = 'dpp-agent-container';
      if (restored) panel.setAttribute('data-restored', 'true');
      const target = resolve(12, [trigger.message, final.message]).target!;
      const host = target.querySelector('.ds-markdown')!;
      expect(placeInlineAgentContainer(12, target, host, panel)).toBe('mounted');
      expect(placeInlineAgentContainer(12, target, host, panel)).toBe('unchanged');
      expect(trigger.message.contains(panel)).toBe(true);
      expect(final.message.contains(panel)).toBe(false);
      panel.remove();
    }
  });

  it('revalidates identity if React recycles a row between lookup and mount', () => {
    const target = row('12');
    const panel = document.createElement('div');
    const host = target.message.querySelector('.ds-markdown')!;
    target.row.setAttribute('data-virtual-list-item-key', '18');
    expect(placeInlineAgentContainer(12, target.message, host, panel)).toBe('identity_changed');
    expect(panel.parentElement).toBeNull();
  });

  it('recognizes identity mutations on the envelope but ignores chart id mutations', () => {
    const target = row('12');
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    target.message.querySelector('.ds-markdown')!.append(chart);
    const mutation = (node: Node, attributeName: string) => ({ type: 'attributes', target: node, attributeName }) as MutationRecord;
    expect(isAssistantMessageIdentityMutation(mutation(target.row, 'data-virtual-list-item-key'))).toBe(true);
    expect(isAssistantMessageIdentityMutation(mutation(chart, 'id'))).toBe(false);
  });
});
