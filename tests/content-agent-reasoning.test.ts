import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { describe, expect, it, vi } from 'vitest';
import { parseTypeScriptSource } from './helpers/typescript-source';
import { createAgentContainer, createAgentStepElement, getAgentConsoleBody, getAgentReasoningNote,
  mountAgentNarration, updateAgentReasoningNoteElement, updateStepStreamText } from '../core/inline-agent/renderer';

const source = readFileSync('entrypoints/content.ts', 'utf8');
const declarations = parseTypeScriptSource('entrypoints/content.ts', source).body.filter(node =>
  node.type === 'FunctionDeclaration' && ['handleAgentReasoningChunk', 'renderInlineAgentStreamChunk'].includes(node.id?.name ?? ''));
const code = declarations.map(node => transform(source.slice(node.start!, node.end!), { transforms: ['typescript'] }).code).join('\n');
const load = new Function('deps', `
  const { inlineAgentContainer, inlineAgentCurrentStep, pendingAgentReasoningByStep,
    getAgentConsoleBody, getAgentReasoningNote, mountAgentNarration,
    updateAgentReasoningNoteElement, updateStepStreamText } = deps;
  const inlineAgentLoopId = 'loop';
  const getAgentRendererLabels = () => ({});
  const updateActiveInlineAgentTrace = () => {};
  const updateInlineAgentTraceStep = () => {};
  const getInlineAgentStepText = step => step.querySelector('.dpp-agent-step-body').textContent;
  const getInlineAgentDisplayStepText = text => text;
  const clampText = text => text;
  const INLINE_AGENT_STEP_RENDER_MAX_CHARS = 12000;
  const currentToolDescriptors = [];
  const refreshAgentStepCodeRunners = () => {};
  ${code}
  return { handleAgentReasoningChunk, renderInlineAgentStreamChunk };
`);

describe('reasoning display while tools run', () => {
  it('does not replace accumulated reasoning with the first word when narration starts', () => {
    const container = createAgentContainer(); const step = createAgentStepElement(0);
    const pending = new Map<number, string>(); document.body.append(container);
    const handlers = load({ inlineAgentContainer: container, inlineAgentCurrentStep: step,
      pendingAgentReasoningByStep: pending, getAgentConsoleBody, getAgentReasoningNote,
      mountAgentNarration, updateAgentReasoningNoteElement, updateStepStreamText });
    try {
      handlers.handleAgentReasoningChunk({ loopId: 'loop', stepIndex: 0, fullText: 'I' });
      const fullText = 'I need to inspect the directory before choosing the next tool.';
      handlers.handleAgentReasoningChunk({ loopId: 'loop', stepIndex: 0, fullText });
      handlers.renderInlineAgentStreamChunk({ loopId: 'loop', stepIndex: 0, fullText: 'Checking the directory.' });
      expect(getAgentReasoningNote(step)?.querySelector('.dpp-agent-reasoning-note-body')?.textContent).toBe(fullText);
      expect(pending.size).toBe(0);
      handlers.renderInlineAgentStreamChunk({ loopId: 'loop', stepIndex: 0, fullText: 'Checking the directory. Next, list its files.' });
      expect(getAgentReasoningNote(step)?.querySelector('.dpp-agent-reasoning-note-body')?.textContent).toBe(fullText);
    } finally { container.remove(); }
  });
});
