import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('content tool block styles', () => {
  it('keeps restored tool detail content scrollable for long source output', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const rule = source.match(/\.dpp-tool-block-item-detail \{([\s\S]*?)\n    \}/)?.[1] ?? '';

    expect(rule).toContain('max-height:');
    expect(rule).toContain('overflow: auto;');
    expect(rule).toContain('overscroll-behavior: contain;');
  });

  it('renders artifact results outside the collapsible executed-tools block', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('.dpp-artifact-results');
    expect(source).toContain('function renderDetachedArtifactResults(');
    expect(source).toContain('isDetachedArtifactToolResult(exec.result)');
    expect(source).toContain('renderDetachedArtifactResultsForBlock(session, toolBlockEl);');
    expect(source).toContain('renderDetachedArtifactResults(target, record.id, executions, block);');
    expect(source).toContain('responseHost.insertBefore(container, anchor);');
  });

  it('keeps rendered tool cleanup bounded for large message bodies', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('CLEANABLE_TEXT_DEEP_SCAN_MAX_CHARS');
    expect(source).toContain('CLEANUP_MESSAGE_SCAN_LIMIT');
    expect(source).toContain('hasLikelyToolMarkerPrefix');
    expect(source).toContain('if (i < minIndex) break;');
  });

  it('uses the shared injected theme variables for readable tool block text', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/import \{ injectInjectedThemeStyles \} from [\"']\.\.\/core\/ui\/injected-theme[\"'];/);
    expect(source).toContain('injectInjectedThemeStyles();');
    expect(source).toContain('color: var(--dpp-ui-text);');
    expect(source).toContain('color: var(--dpp-ui-text-muted);');
    expect(source).not.toContain('body.dpp-theme-dark .dpp-tool-block-item { color: rgb(200, 200, 200); }');
  });

  it('mounts inline agent output in the bound message response host instead of the reasoning block', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/const ASSISTANT_RESPONSE_CONTENT_SELECTOR\s*=\s*[\"']\._74c0879, \.ds-assistant-message-main-content[\"'];/);
    expect(source).toContain('已(?:深度)?思考');
    expect(source).toContain('思考过程');
    expect(source).toContain('REASONING_HOST_ANCESTOR_SCAN_DEPTH');
    expect(source).toContain('countContentHosts(ancestor) === 1');
    expect(source).toContain('placeInlineAgentContainer(trace.anchorMessageId, message, getAssistantResponseHost(message), container)');
    expect(source).toContain('reconcileLiveInlineAgentContainer();');
    expect(source).not.toContain('inlineAgentContainerObserver');
  });

  it('scopes task_complete cleanup to assistant body text outside code blocks', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('function shouldReplaceRenderedTaskCompleteBlock(textNode: Text): boolean');
    expect(source).toContain('if (parent.closest("pre, code")) return false;');
    expect(source).toContain('const message = parent.closest(".ds-message");');
    expect(source).toMatch(/return getAssistantContentHosts\(message\)\.some\(\(host\) =>\s*host\.contains\(parent\),?\s*\);/);
  });

  it('normalizes restored inline-agent traces that predate finalText storage', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const codec = readFileSync(
      join(process.cwd(), 'core/inline-agent/trace-codec.ts'),
      'utf8',
    );

    expect(codec).toContain('requireOptionalString(trace.finalText, `${path}.finalText`)');
    expect(source).toContain('const finalText = typeof trace.finalText === "string" ? trace.finalText : "";');
    expect(source).toContain('finalText: clampText(finalText, INLINE_AGENT_FINAL_RENDER_MAX_CHARS) ?? "",');
  });

  it('hides internal inline-agent continuation user messages instead of rendering empty turns', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('startInlineAgentContinuationMessageHider(scope, mutationHub);');
    expect(source).toContain('INLINE_AGENT_CONTINUATION_PLACEHOLDER');
    expect(source).toContain('reconcileContinuationVisibility(root, ownedContinuationRequestMessageIds');
    expect(source).not.toContain('isInlineAgentContinuationRenderedText');
    expect(source).toContain('hideInlineAgentContinuationMessages(root);');
    const visibility = readFileSync(join(process.cwd(), 'core/inline-agent/continuation-visibility.ts'), 'utf8');
    expect(visibility).toContain("message.style.display = 'none'");
    expect(source).toContain("data-dpp-hidden-inline-agent-continuation");
  });

  it('retries persisted tool and inline-agent restoration when long histories mount late', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/from [\"']\.\/content\/restored-message-targets[\"'];/);
    expect(source).toContain('restoredRenderAttempts = 0;');
    expect(source).toContain('scheduleRenderRestoredToolBlocks();');
    expect(source).toContain('restoredInlineAgentRenderAttempts = 0;');
    expect(source).toContain('scheduleRenderRestoredInlineAgentTraces();');
  });

  it('keeps permission banner text on the same injected theme contract', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const rule = source.match(/\.dpp-permission-banner \{([\s\S]*?)\n    \}/)?.[1] ?? '';

    expect(rule).toContain('background: var(--dpp-ui-surface);');
    expect(rule).toContain('color: var(--dpp-ui-text);');
    expect(source).not.toContain('var(--ds-text');
    expect(source).not.toContain('var(--ds-text-secondary');
  });

  it('suppresses the legacy tool block when an inline agent takes over the run record', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    // The agent flow owns the tool presentation of the anchor message: the
    // old-style collapsible block is removed from the DOM...
    expect(source).toContain('function removeToolBlockFromMessage(message: Element): void');
    expect(source).toContain(':scope > .dpp-tool-block, :scope > .dpp-artifact-results');
    expect(source).toContain('removeToolBlockFromMessage(target);');
    // ...and the trigger turn's executions render as the FIRST new-style tool
    // group (step index -1 keeps it ahead of every loop step).
    expect(source).toContain('resolveAgentToolEntry(stream, -1, exec, getAgentRendererLabels());');
    // The tool block never coexists with the agent container: the dedicated
    // "indented when followed by an agent" rule is gone.
    expect(source).not.toContain('.dpp-tool-block:has(~ .dpp-agent-container)');
  });

  it('persists and restores the trigger-turn executions inside the agent trace', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    const codec = readFileSync(join(process.cwd(), 'core/inline-agent/trace-codec.ts'), 'utf8');

    expect(source).toMatch(/initialExecutions: initialExecutions\.map\(\(execution\) =>\s*sanitizeToolExecutionForRestoreStorage\(execution\),?\s*\)/);
    expect(source).toContain('for (const exec of trace.initialExecutions ?? [])');
    expect(codec).toContain('${path}.initialExecutions must contain valid tool execution records');
  });

  it('skips restoring legacy tool blocks that belong to an agent-run message', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/function isToolBlockRecordOwnedByAgentRun\(\s*record: ToolCallRestoreRecord,?\s*\): boolean/);
    expect(source).toContain('activeInlineAgentTrace?.anchorMessageId === assistantMessageId');
    expect(source).toContain('for (const trace of restoredInlineAgentTraces.values())');
    expect(source).toContain('if (isToolBlockRecordOwnedByAgentRun(record)) {');
  });

  it('retires the artifact conversion from the agent display chain', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const displayText = readFileSync(join(process.cwd(), 'core/inline-agent/display-text.ts'), 'utf8');

    // The retired artifact protocol is stripped by the shared pure display
    // functions (display-text.ts), which content.ts delegates to with the
    // active tool catalog — the raw protocol never surfaces and nothing is
    // silently swallowed (the loop nudges empty-promise turns into a
    // renderable re-delivery).
    expect(source).not.toContain('convertInlineAgentArtifactBlocks');
    expect(source).toMatch(/getInlineAgentDisplayFinalText\(\s*msg\.finalText,\s*currentToolDescriptors,?\s*\)/);
    expect(source).toMatch(/getInlineAgentDisplayStepText\(\s*msg\.fullText,\s*currentToolDescriptors,?\s*\)/);
    expect(source).toContain('function getInlineAgentRestoredStepText(text: string): string');
    expect(displayText).toContain('export function getInlineAgentDisplayFinalText(');
    expect(displayText).toContain('export function getInlineAgentDisplayStepText(');
    expect(displayText).toContain('stripRetiredArtifactProtocolBlocks');
    // Web final answers are committed to the trace first, then the loop owner
    // closes authorization and reloads the real DeepSeek history. No synthetic
    // fetch/XHR response or replay bridge protocol remains.
    expect(source).toContain('await persistInlineAgentTraceImmediately(completedTrace);');
    expect(source).toContain('shouldReloadInlineAgentNativeHistory({');
    expect(source).toContain('if (shouldReloadNativeHistory) reloadInlineAgentNativeHistory();');
    expect(source).toContain('isInlineAgentNativeHistoryBackedTrace(trace)');
    expect(source).toContain('const nativeHistoryOwnsFinalTurn =');
    const loopStart = source.indexOf('async function startInlineAgentLoop(');
    const loopEnd = source.indexOf('\nfunction handleInlineAgentLoopEvent(', loopStart);
    const loopSource = source.slice(loopStart, loopEnd);
    expect(loopSource.indexOf('const terminalResults = await Promise.all(terminalTasks);'))
      .toBeLessThan(loopSource.indexOf('await closeContentToolAuthorization(authorizationRequestKey);'));
    expect(loopSource.indexOf('await closeContentToolAuthorization(authorizationRequestKey);'))
      .toBeLessThan(loopSource.indexOf('reloadInlineAgentNativeHistory();'));
    expect(source).not.toContain('deliverInlineAgentFinalAnswerNatively');
    expect(source).not.toContain('registerAgentReplay');
    const fetchHook = readFileSync(
      join(process.cwd(), 'core/interceptor/fetch-hook.ts'),
      'utf8',
    );
    const bridgeSchema = readFileSync(
      join(process.cwd(), 'core/messaging/schema.ts'),
      'utf8',
    );
    expect(fetchHook).not.toContain('buildAgentReplayResponse');
    expect(fetchHook).not.toContain('simulateAgentReplayXhrResponse');
    expect(bridgeSchema).not.toContain('REGISTER_AGENT_REPLAY');
    expect(bridgeSchema).not.toContain('AGENT_REPLAY_REGISTERED');
  });

  it('hydrates incremental code-run actions on agent console code blocks', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const renderer = readFileSync(join(process.cwd(), 'core/inline-agent/renderer.ts'), 'utf8');
    const markdown = readFileSync(join(process.cwd(), 'core/inline-agent/markdown.ts'), 'utf8');

    expect(source).toContain('function refreshAgentStepCodeRunners(step: HTMLElement): void');
    expect(source).toContain('type: "RUN_ARTIFACT_CODE"');
    expect(renderer).toContain('export function hydrateAgentStepCodeRunners(');
    expect(renderer).toContain('AGENT_NATIVE_DELIVERABLE_CODE_LANGS');
    expect(renderer).toContain('omitFencedCodeLanguages: AGENT_NATIVE_DELIVERABLE_CODE_LANGS');
    expect(markdown).toContain('data-dpp-lang');
  });

  it('keeps the unified new-style tool group wording in both locales', () => {
    const zh = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');
    const en = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');

    expect(zh).toContain("toolGroup: '已调用 {count} 次工具'");
    expect(en).toContain("toolGroup: 'Ran {count} tool calls'");
    expect(zh).toContain("codeRun: '运行'");
    expect(en).toContain("codeRun: 'Run'");
  });
  it('removes the obsolete global code-download overlay capability completely', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    const zh = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');
    const en = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');

    expect(existsSync(join(process.cwd(), 'entrypoints/content/adapters/ux-polish.ts'))).toBe(false);
    expect(source).not.toContain('startContentUxPolish');
    expect(source).not.toMatch(/createDomCapability\([\"']ux-polish[\"']/);
    expect(source).not.toContain('content.uxPolish.downloadCode');
    expect(zh).not.toContain('uxPolish:');
    expect(en).not.toContain('uxPolish:');
  });

});
