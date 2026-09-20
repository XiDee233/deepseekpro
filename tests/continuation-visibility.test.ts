import { describe, expect, it, vi } from 'vitest';
import {
  decideContinuationVisibility, reconcileContinuationVisibility,
  mutationMayAffectContinuationVisibility, HIDDEN_CONTINUATION_ATTRIBUTE,
} from '../core/inline-agent/continuation-visibility';
import { INLINE_AGENT_CONTINUATION_PLACEHOLDER } from '../core/inline-agent/prompt';

function message(id: number, assistant = false) {
  const row = document.createElement('div');
  row.setAttribute('data-virtual-list-item-key', String(id));
  const node = document.createElement('div');
  node.className = 'ds-message';
  if (assistant) node.innerHTML = '<div class="ds-assistant-message-main-content"></div>';
  row.append(node);
  return { row, node };
}
const example = '<original_task>task</original_task><tool_results>results</tool_results>';

describe('internal continuation visibility', () => {
  it('restores the reported hidden assistant reply quoting source code, preserving its body', () => {
    const { row, node } = message(42, true);
    const body = node.firstElementChild!;
    const code = document.createElement('pre');
    code.textContent = example;
    body.append('Normal answer with source examples.', code);
    const before = body.innerHTML;
    node.setAttribute(HIDDEN_CONTINUATION_ATTRIBUTE, 'true');
    node.style.cssText = '--panel-width: 0px; display: none';
    const changed = vi.fn();
    reconcileContinuationVisibility(row, new Map(), changed);
    expect(node.hasAttribute(HIDDEN_CONTINUATION_ATTRIBUTE)).toBe(false);
    expect(node.style.display).toBe('');
    expect(node.style.getPropertyValue('--panel-width')).toBe('0px');
    expect(body.innerHTML).toBe(before);
    expect(changed).toHaveBeenCalledWith(node, { hidden: false, reason: 'assistant_visible' });
    reconcileContinuationVisibility(row, new Map(), changed);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('keeps user questions and assistant replies about continuation tags visible', () => {
    for (const assistant of [true, false]) {
      const { row, node } = message(42, assistant);
      (node.firstElementChild ?? node).textContent = `Explain this: ${example}`;
      reconcileContinuationVisibility(row, new Map());
      expect(node.style.display).toBe('');
      expect(node.textContent).toContain(example);
    }
  });

  it('hides only a known native request id, and assistant identity takes precedence', () => {
    const { row, node } = message(41);
    node.textContent = example;
    const known = new Map([['41', '']]);
    const changed = vi.fn();
    reconcileContinuationVisibility(row, known, changed);
    expect(node.style.display).toBe('none');
    expect(changed).toHaveBeenCalledWith(node, { hidden: true, reason: 'owned_continuation' });
    reconcileContinuationVisibility(row, known, changed);
    expect(changed).toHaveBeenCalledOnce();
    node.innerHTML = '<div class="ds-assistant-message-main-content">A normal reply</div>';
    reconcileContinuationVisibility(row, known);
    expect(node.style.display).toBe('');
  });

  it('hides a complete history placeholder but not references to it', () => {
    const { node } = message(41);
    node.textContent = `\n${INLINE_AGENT_CONTINUATION_PLACEHOLDER}\n`;
    expect(decideContinuationVisibility(node, new Map())).toEqual({ hidden: true, reason: 'continuation_placeholder' });
    node.textContent = `Example: ${INLINE_AGENT_CONTINUATION_PLACEHOLDER}`;
    expect(decideContinuationVisibility(node, new Map()).hidden).toBe(false);
    node.innerHTML = '<pre><code></code></pre>';
    node.querySelector('code')!.textContent = INLINE_AGENT_CONTINUATION_PLACEHOLDER;
    expect(decideContinuationVisibility(node, new Map()).hidden).toBe(false);
  });

  it('unhides recycled rows and reacts when content loses the placeholder', () => {
    const { row, node } = message(41);
    node.textContent = example;
    reconcileContinuationVisibility(row, new Map([['41', '']]));
    row.setAttribute('data-virtual-list-item-key', '42');
    node.textContent = 'Ordinary text';
    reconcileContinuationVisibility(row, new Map([['41', '']]));
    expect(node.style.display).toBe('');
    expect(mutationMayAffectContinuationVisibility({ type: 'characterData', target: node.firstChild!,
      addedNodes: [] } as unknown as MutationRecord)).toBe(true);
  });

  it('does not remove display rules not owned by the plugin', () => {
    const { row, node } = message(42, true);
    node.style.display = 'none';
    reconcileContinuationVisibility(row, new Map());
    expect(node.style.display).toBe('none');
  });

  it('handles a late-rendered child without rescanning unrelated messages', () => {
    const { node } = message(41);
    node.innerHTML = '<span>pending</span>';
    reconcileContinuationVisibility(node.firstElementChild!, new Map([['41', '']]));
    expect(node.style.display).toBe('none');
  });
});

it('shows inserted user text in the native bubble and leaves adjacent actions intact', () => {
  const { row, node } = message(3);
  node.innerHTML = '<div class="ds-collapsible-text"><span></span></div>';
  node.querySelector('span')!.textContent = INLINE_AGENT_CONTINUATION_PLACEHOLDER;
  node.setAttribute(HIDDEN_CONTINUATION_ATTRIBUTE, 'true'); node.style.display = 'none';
  const actions = document.createElement('div'); actions.textContent = 'copy edit'; row.append(actions);
  const changed = vi.fn();
  const input = '你好\n<img src=x onerror=alert(1)>';
  reconcileContinuationVisibility(row, new Map([['3', input]]), changed);
  expect(node.style.display).toBe('');
  expect(node.textContent).toBe(input);
  expect(node.querySelector('img')).toBeNull();
  expect(actions.parentElement).toBe(row);
  expect(changed).toHaveBeenCalledWith(node, { hidden: false, reason: 'user_input_visible', userText: input });
  reconcileContinuationVisibility(row, new Map([['3', input]]), changed);
  expect(changed).toHaveBeenCalledOnce();
});
