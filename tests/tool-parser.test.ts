import { describe, expect, it } from 'vitest';
import { createArtifactToolDescriptors } from '../core/artifact';
import { extractLegacyToolCalls, extractToolCalls, stripToolCalls } from '../core/interceptor/tool-parser';

describe('tool-parser XML fallback', () => {
  const descriptors = createArtifactToolDescriptors('en');

  it('exposes legacy-only extraction without changing the combined parser', () => {
    const xml = '<artifact_create>{"filename":"xml.txt","content":"xml"}</artifact_create>';
    const invoke = '<｜DSML｜invoke name="artifact_create">'
      + '<｜DSML｜parameter name="filename" string="true">legacy.txt</｜DSML｜parameter>'
      + '</｜DSML｜invoke>';
    const text = xml + `<｜DSML｜tool_calls>${invoke}${invoke}</｜DSML｜tool_calls>`;
    const legacy = extractLegacyToolCalls(text, { descriptors });
    expect(legacy).toHaveLength(2);
    expect(legacy.map((call) => call.payload.filename)).toEqual(['legacy.txt', 'legacy.txt']);
    expect(extractToolCalls(text, { descriptors }).slice(1)).toEqual(legacy);
    expect(extractLegacyToolCalls(xml, { descriptors })).toEqual([]);
  });

  it('parses and strips whitespace-padded direct tool tags', () => {
    const text = [
      'Before ',
      '< artifact_create >',
      JSON.stringify({ filename: 'demo.html', content: '<canvas></canvas>' }),
      '</ artifact_create >',
      ' after',
    ].join('');

    const calls = extractToolCalls(text, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'artifact_create',
      payload: { filename: 'demo.html', content: '<canvas></canvas>' },
    });
    expect(stripToolCalls(text, { descriptors })).toBe('Before  after');
  });
});
