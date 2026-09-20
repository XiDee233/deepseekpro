/** Observes protocol shapes only; never repairs or changes parser input. */
export function createToolProtocolCounter() {
  const counts = { dsmlMarkers: 0, dsmlToolCalls: 0, dsmlCalls: 0, dsmlInvokes: 0 };
  let tail = '';
  return {
    append(text: string) {
      const combined = tail + text;
      for (const match of combined.matchAll(/DSML/g)) {
        if (match.index + match[0].length > tail.length) counts.dsmlMarkers += 1;
      }
      // Prefix-only matching avoids retaining parameter names or values. A
      // bounded tail handles tags split over frames, including spaced pipes.
      for (const match of combined.matchAll(/<[｜|\s]{0,16}DSML[｜|\s]{0,16}(tool_calls|calls|invoke)(?=[\s>])/g)) {
        if (match.index + match[0].length + 1 <= tail.length) continue;
        if (match[1] === 'tool_calls') counts.dsmlToolCalls += 1;
        else if (match[1] === 'calls') counts.dsmlCalls += 1;
        else counts.dsmlInvokes += 1;
      }
      tail = combined.slice(-64);
    },
    snapshot: () => ({ ...counts }),
  };
}

export function summarizeToolProtocol(text: string) {
  const counter = createToolProtocolCounter();
  counter.append(text);
  return counter.snapshot();
}
