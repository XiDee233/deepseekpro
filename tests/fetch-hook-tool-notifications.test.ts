import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactToolDescriptors } from '../core/artifact';
import { createRequestContext, interceptFetchResponse, updateHookState } from '../core/interceptor/fetch-hook';
import * as streamingParser from '../core/interceptor/streaming-tool-call-parser';
import { isExternalizedToolPayload } from '../core/tool/externalized-payload';
import type { ToolCall } from '../core/types';

const descriptors = createArtifactToolDescriptors('en');
const xml = (filename: string, content: string) =>
  `<artifact_create>${JSON.stringify({ filename, content })}</artifact_create>`;
const legacyInvoke = '<｜DSML｜invoke name="artifact_create">'
  + '<｜DSML｜parameter name="filename" string="true">legacy.txt</｜DSML｜parameter>'
  + '<｜DSML｜parameter name="content" string="true">legacy</｜DSML｜parameter>'
  + '</｜DSML｜invoke>';
const legacyBlock = (body: string) => `<｜DSML｜tool_calls>${body}</｜DSML｜tool_calls>`;

describe('response-owned tool notifications', () => {
  const onToolCall = vi.fn<(call: ToolCall) => void>();
  const onToolCallStarted = vi.fn<(call: ToolCall) => void>();
  const onToolCallChunk = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    updateHookState({
      toolDescriptors: descriptors,
      onToolCall,
      onToolCallStarted,
      onToolCallChunk,
      onResponseComplete: vi.fn(),
      onRequestTerminal: vi.fn(),
      onResponseTokenSpeed: vi.fn(),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function deliver(text: string, requestId = 'request-tools') {
    // Split both tool tags and bodies across SSE events, including externalized payloads.
    const frames: string[] = [];
    for (let index = 0; index < text.length; index += 4093) {
      frames.push(`data: ${JSON.stringify({ p: 'response/content', o: 'APPEND', v: text.slice(index, index + 4093) })}\n\n`);
    }
    frames.push('data: {"p":"response/status","v":"FINISHED"}\n\n');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    }));
    const wrapped = await interceptFetchResponse(
      Promise.resolve(response),
      createRequestContext('{"prompt":"create artifacts"}', { requestId }),
    );
    await wrapped.text();
  }

  it.each([5, 3000, 65000])('preserves identical occurrences with %i-character content', async (length) => {
    const call = xml('a.txt', 'a'.repeat(length));
    await deliver(call + call);
    const calls = onToolCall.mock.calls.map(([call]) => call);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(calls.map((call) => call.id)).toEqual(onToolCallStarted.mock.calls.map(([call]) => call.id));
  });

  it.each([3000, 65000])('preserves different equal-length payloads with %i-character content', async (length) => {
    await deliver(xml('a.txt', 'a'.repeat(length)) + xml('b.txt', 'b'.repeat(length)));
    const calls = onToolCall.mock.calls.map(([call]) => call);
    expect(calls).toHaveLength(2);
    expect(calls[0].raw).toBe(calls[1].raw);
    expect(calls[0].id).not.toBe(calls[1].id);
    for (const [index, call] of calls.entries()) {
      const expected = { filename: index === 0 ? 'a.txt' : 'b.txt', content: (index === 0 ? 'a' : 'b').repeat(length) };
      if (length > 64000) {
        expect(isExternalizedToolPayload(call.payload)).toBe(true);
        const body = onToolCallChunk.mock.calls
          .map(([chunk]) => chunk)
          .filter((chunk) => chunk.id === call.id)
          .map((chunk) => chunk.chunk).join('');
        expect(JSON.parse(body)).toEqual(expected);
      } else {
        expect(call.payload).toEqual(expected);
      }
    }
  });

  it.each([5, 3000, 65000])('does not reparse %i-character XML during DSML completion', async (length) => {
    await deliver(xml('a.txt', 'a'.repeat(length)) + legacyBlock(legacyInvoke));
    const calls = onToolCall.mock.calls.map(([call]) => call);
    expect(calls).toHaveLength(2);
    expect(calls[0].id).toBe(onToolCallStarted.mock.calls[0][0].id);
    expect(calls[1]).toMatchObject({
      id: 'legacy:request-tools:0',
      payload: { filename: 'legacy.txt', content: 'legacy' },
      source: { requestId: 'request-tools' },
    });
  });

  it('preserves separate identical legacy occurrences', async () => {
    await deliver(legacyBlock(legacyInvoke + legacyInvoke));
    expect(onToolCall.mock.calls.map(([call]) => call.id)).toEqual([
      'legacy:request-tools:0', 'legacy:request-tools:1',
    ]);
  });

  it('does not let an empty DSML block re-notify a long XML call', async () => {
    await deliver(xml('a.txt', 'a'.repeat(3000)) + legacyBlock(''));
    expect(onToolCall).toHaveBeenCalledOnce();
  });

  it('keeps parse failures distinct even when their raw previews match', async () => {
    const invalid = `<artifact_create>${'x'.repeat(3000)}</artifact_create>`;
    await deliver(invalid + invalid + legacyBlock(''));
    expect(onToolCall).toHaveBeenCalledTimes(2);
    for (const [call] of onToolCall.mock.calls) {
      expect(call.parseError?.code).toBe('tool_call_json_invalid');
    }
  });

  it('does not share notification identity between overlapping requests', async () => {
    const text = xml('a.txt', 'hello') + legacyBlock(legacyInvoke);
    await Promise.all([deliver(text, 'request-a'), deliver(text, 'request-b')]);
    expect(onToolCall).toHaveBeenCalledTimes(4);
    for (const requestId of ['request-a', 'request-b']) {
      expect(onToolCall.mock.calls.filter(([call]) => call.source?.requestId === requestId)).toHaveLength(2);
    }
  });

  it('notifies once when a parser completion with the same ID is delivered twice', async () => {
    const createParser = streamingParser.createStreamingToolCallParser;
    vi.spyOn(streamingParser, 'createStreamingToolCallParser').mockImplementation((...args) => {
      const parser = createParser(...args);
      return {
        append(text) {
          const event = parser.append(text);
          return { ...event, completed: [...event.completed, ...event.completed] };
        },
        flush: () => parser.flush(),
      };
    });
    await deliver(xml('a.txt', 'hello'));
    expect(onToolCall).toHaveBeenCalledOnce();
  });
});
