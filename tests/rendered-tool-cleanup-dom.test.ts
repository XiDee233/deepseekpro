import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTypeScriptSource } from './helpers/typescript-source';
import { containsInternalPromptMarker, sanitizeInternalPromptText } from '../core/prompt/visibility';
import { INLINE_AGENT_CONTINUATION_PLACEHOLDER, replaceTaskCompleteBlocks } from '../core/inline-agent/prompt';
import { createToolInvocationCatalog, DEFAULT_TOOL_DESCRIPTORS } from '../core/tool/invocation';
import { LEGACY_TOOL_CALLS_OPEN_TAG } from '../core/interceptor/tool-parser';

// Run the actual content-entrypoint functions, without starting browser capabilities.
const source = readFileSync('entrypoints/content.ts', 'utf8');
const names = new Set([
  'stripToolCallTextNodes', 'pruneEmptyToolContainers', 'containsCleanableText',
  'containsToolMarker', 'hasLikelyToolMarkerPrefix', 'sanitizeRenderedControlText',
  'shouldReplaceRenderedTaskCompleteBlock', 'getAssistantContentHosts',
  'collapseRenderedExcessBlankLines', 'escapeRegExp', 'buildToolOpenTagRegex',
  'buildToolMarkerRegex', 'buildToolTagPattern',
]);
const declarations = parseTypeScriptSource('entrypoints/content.ts', source).body
  .filter(node => node.type === 'FunctionDeclaration' && node.id && names.has(node.id.name))
  .map(node => source.slice(node.start!, node.end!)).join('\n');
const code = transform(declarations, { transforms: ['typescript'] }).code;
const stripToolCallTextNodes = new Function('dependencies', `
  const { containsInternalPromptMarker, sanitizeInternalPromptText,
    INLINE_AGENT_CONTINUATION_PLACEHOLDER, replaceTaskCompleteBlocks,
    createToolInvocationCatalog, DEFAULT_TOOL_DESCRIPTORS, LEGACY_TOOL_CALLS_OPEN_TAG } = dependencies;
  const CLEANABLE_TEXT_DEEP_SCAN_MAX_CHARS = 120000;
  const ASSISTANT_RESPONSE_CONTENT_SELECTOR = '._74c0879, .ds-assistant-message-main-content';
  ${code}
  const toolOpenTagRe = buildToolOpenTagRegex(DEFAULT_TOOL_DESCRIPTORS);
  const toolMarkerRe = buildToolMarkerRegex(DEFAULT_TOOL_DESCRIPTORS);
  return stripToolCallTextNodes;
`)({ containsInternalPromptMarker, sanitizeInternalPromptText,
  INLINE_AGENT_CONTINUATION_PLACEHOLDER, replaceTaskCompleteBlocks,
  createToolInvocationCatalog, DEFAULT_TOOL_DESCRIPTORS, LEGACY_TOOL_CALLS_OPEN_TAG,
}) as (root: Element) => void;

afterEach(() => document.body.replaceChildren());

function fixture(texts: string[]) {
  const message = document.createElement('div');
  message.className = 'ds-message';
  const host = document.createElement('div');
  host.className = 'ds-assistant-message-main-content';
  const paragraph = document.createElement('p');
  paragraph.className = 'ds-markdown-paragraph';
  const spans = texts.map(text => {
    const span = document.createElement('span');
    span.append(document.createTextNode(text));
    paragraph.append(span);
    return span;
  });
  host.append(paragraph);
  message.append(host);
  document.body.append(message);
  return { message, host, paragraph, spans };
}

describe('rendered tool cleanup preserves native DOM ownership', () => {
  it('keeps the reference span usable by the next native insertBefore', () => {
    const { message, paragraph, spans: [before] } = fixture([
      '<web_search>{"query":"example"}</web_search>', 'ordinary answer',
    ]);
    const text = before.firstChild;
    stripToolCallTextNodes(message);
    const math = document.createElement('span');
    math.className = 'ds-markdown-math-svg';
    // Mirrors the reported p.ds-markdown-paragraph / span reference failure.
    expect(() => paragraph.insertBefore(math, before)).not.toThrow();
    expect(before.parentNode).toBe(paragraph);
    expect(before.firstChild).toBe(text);
    expect(before.textContent).toBe('');
  });

  it('retains an entirely cleaned paragraph and its original Text node for later updates', () => {
    const { message, host, paragraph, spans: [span] } = fixture(['<web_search>{}</web_search>']);
    const text = span.firstChild!;
    stripToolCallTextNodes(message);
    stripToolCallTextNodes(message);
    expect(paragraph.parentNode).toBe(host);
    expect(span.parentNode).toBe(paragraph);
    expect(span.firstChild).toBe(text);
    text.nodeValue = 'native renderer resumed';
    expect(message.textContent).toBe('native renderer resumed');
  });

  it('strips a tool call spanning multiple nodes without deleting any of them', () => {
    const { message, paragraph, spans } = fixture(['<web_search>', '{"query":"example"}', '</web_search>visible']);
    const texts = spans.map(span => span.firstChild);
    stripToolCallTextNodes(message);
    expect(message.textContent).toBe('visible');
    expect(Array.from(paragraph.children)).toEqual(spans);
    expect(spans.map(span => span.firstChild)).toEqual(texts);
  });

  it('does not touch extension-owned tool result content', () => {
    const { message, spans: [span] } = fixture(['<web_search>{}</web_search>']);
    span.className = 'dpp-tool-block';
    stripToolCallTextNodes(message);
    expect(span.textContent).toBe('<web_search>{}</web_search>');
    expect(span.isConnected).toBe(true);
  });
});
