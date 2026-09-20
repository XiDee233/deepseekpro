import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { describe, expect, it, vi } from 'vitest';
import { parseTypeScriptSource } from './helpers/typescript-source';
import { selectContinuableToolExecutions } from '../core/inline-agent/execution-policy';

// Exercise the actual early-return branches without mounting DOM capabilities.
const source = readFileSync('entrypoints/content.ts', 'utf8');
const declaration = parseTypeScriptSource('entrypoints/content.ts', source).body.find(
  (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'startInlineAgentIfNeeded',
)!;
const code = transform(source.slice(declaration.start!, declaration.end!), { transforms: ['typescript'] }).code;
const load = new Function('dependencies', `
  const { reportAgentDiagnostic, isInlineAgentResponseComplete, isInlineAgentRunning,
    selectContinuableToolExecutions, showContentToast, contentT, activeToolAuthorizations } = dependencies;
  const pendingInputOwner = null;
  ${code}
  return startInlineAgentIfNeeded;
`) as (dependencies: Record<string, unknown>) => (...args: unknown[]) => Promise<void>;

describe('content continuation diagnostics', () => {
  it.each(['internal_response', 'already_running', 'no_continuable_tools', 'missing_chain', 'missing_authorization'])(
    'records the actual %s branch without starting a loop', async (reason) => {
      const report = vi.fn();
      const run = load({
        reportAgentDiagnostic: report,
        isInlineAgentResponseComplete: () => reason === 'internal_response',
        isInlineAgentRunning: () => reason === 'already_running',
        selectContinuableToolExecutions,
        showContentToast: vi.fn(), contentT: (key: string) => key, activeToolAuthorizations: new Map(),
      });
      const executions = reason === 'no_continuable_tools' ? [] : [{
        name: 'shell_exec', provider: { kind: 'mcp', id: 'test', displayName: 'test', transport: 'stdio' },
        result: { ok: true, summary: 'secret-output' },
      }];
      await run({ requestId: 'request-content', chatSessionId: 'chat-content',
        assistantMessageId: reason === 'missing_chain' ? null : 42, text: 'secret-answer' }, executions);
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(expect.objectContaining({
        event: 'continuation_decision', reason, requestId: 'request-content', chatSessionId: 'chat-content',
      }));
      expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
    },
  );
});

it('does not synthesize successful Shell execution from a historical call alone', () => {
  const declaration = parseTypeScriptSource('entrypoints/content.ts', source).body.find(
    node => node.type === 'FunctionDeclaration' && node.id?.name === 'summarizeRestoredToolCall',
  )!;
  const code = transform(source.slice(declaration.start!, declaration.end!), { transforms: ['typescript'] }).code;
  const summarize = new Function(`
    const hasRestoreOmittedPayload = () => false;
    const createRestoredArtifactToolResult = () => null;
    const currentContentLocale = 'en';
    const contentT = key => key;
    ${code}
    return summarizeRestoredToolCall;
  `)();
  for (const name of ['shell_status', 'shell_exec']) {
    expect(summarize({ name, payload: {} })).toMatchObject({ ok: false,
      summary: 'content.toolBlock.summaries.unconfirmed', error: { code: 'tool_result_unconfirmed', retryable: false } });
  }
});
