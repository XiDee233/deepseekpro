# Agent diagnostic log contract

Diagnostics observe existing execution decisions; they do not change parsing,
continuation, retry, authorization, prompts or `AGENT_*` events.

## Collection and export

The existing Export diagnostic logs action exports the background's bounded,
in-memory buffer. No storage key or durable journal is added. It retains at most
1,000 entries and 512 Ki UTF-16 JSON code units and clears when the background
worker restarts. Export shortly after reproducing a problem.

`RECORD_AGENT_DIAGNOSTIC` passes runtime sender authorization before its strict
payload decoder. Unknown keys, nested values, unbounded strings, invalid counts
and unknown event/reason names are rejected. `RESPONSE_DIAGNOSTIC` uses the
existing MAIN/content session and direction-specific bridge codec; only
interceptor events are accepted there. MAIN is untrusted: observations and
request IDs are correlation claims, never authorization. The background adds
browser-derived sender tab/frame/document IDs separately.

Delivery has one attempt and no retries. Failure emits a fixed console warning,
without normal RPC context invalidation or changes to execution. Earlier events
can be evicted; an absent event does not prove its operation never happened.

The export includes the background `buildId`. Agent/interceptor entries include
their originating `buildId` and `observedAt`; enclosing `ts` is receipt time.
Build IDs contain package version and build timestamp. Differing build IDs can
reveal an old content script in an open page. Tests report `unbundled`.

## Events and interpretation

Use `requestId` for the native response, `loopId` for continuation, `toolCallId`
for one tool, and receiver-owned sender fields for tabs/documents. A loop retains
its initial capability request ID; `requestCount` and `stepIndex` identify turns.

- `content_ready` identifies the loaded content build.
- `stream_started` records transport and descriptor count. `stream_summary`
  records frame/wire sizes, server completion and message ID. A second summary
  for the same request records parsed call/error counts, fallback truncation
  and protocol features. `stream_failed` distinguishes abort, timeout, rejected
  fetch, missing body and stream failure.
- `dsmlToolCalls`, `dsmlCalls`, `dsmlInvokes` count observed prefixes, including
  spaced ASCII/full-width pipes across chunks. `dsmlMarkers` counts marker
  occurrences; `visibleDsmlMarkers` counts markers remaining in the response
  summary. These observations do not imply that a spelling is supported.
- `tool_parsed` and `tool_received` distinguish parsing from content receipt.
  `tool_dispatch_finished` identifies content-side parse rejection before
  runtime dispatch. Background `tool-runtime` entries include correlation,
  safe error codes and elapsed time, including rejection/history-write failure.
- `response_received`, `response_tools_settled`, `continuation_decision` expose
  the first-turn handoff. Reasons distinguish internal or superseded responses,
  concurrent loops, no continuable tools, missing chain/grant, inactive document
  and unavailable DOM anchor.
- `loop_started`, `model_request`, `turn_finished`, `turn_decision`,
  `nudge_queued`, `tool_result`, `loop_finished` expose the loop. Reasons include
  natural no-tool answer, explicit completion, missing chain, step budget,
  exhausted nudge, abort and errors. `natural_answer` records a heuristic;
  it does not certify completion or distinguish a request for user input.
- `model_stream_summary` observes raw model text features and parser errors
  for both web and official-API backends, before text/tool mapping discards
  protocol markup. Compare it with `turn_finished` and `tool_result`.
- `agent_anchor_decision` records the expected trigger `anchorMessageId`,
  candidate count and identity source (`message_attribute` or the owning
  `virtual_item_key`). Missing, ambiguous or already claimed messages remain
  pending. Repeated unchanged decisions are suppressed in a bounded,
  lifecycle-cleared cache; no message body or snippet is logged.
- `agent_ui_mounted` records the actual `matchedMessageId` and whether the panel
  was restored. Both live and restored panels use the same resolver and mount
  function. Only the native message envelope and its single-message virtual
  row supply identity; generated markdown/SVG ids, text similarity, newest
  message and saved window indexes cannot select an anchor.
- `agent_ui_detached` records an invalidated binding (for example a recycled
  virtual row). The existing mutation hub revalidates live/restored placement
  and waits for the original message instead of attaching to another answer.
- `agent_restore_render` records rendered step count, final response ID and
  whether native history owns the final turn. It explains omitted final steps
  without including their text. No trace schema or final-answer policy changed.
- `loop_stop_requested` distinguishes user stop, capability teardown and loop
  replacement. Pair it with the eventual `aborted` event.

`failureKind` is inferred from known error wording; valid HTTP status numbers
are retained as `httpStatus`. Unknown errors remain `unknown`. Error text is
never stored by this classification.

## Privacy and validation

New fields never contain full prompts/responses, tool arguments/commands/output,
file contents, credentials or grant IDs. Tool-runtime exports use metadata
instead of previous output/error snippets. This is an operational trace, not a
replay transcript. IDs are still sensitive correlation metadata.

Tests cover decoding, export, privacy, failed delivery, every protocol split,
actual first-turn branches, loop decisions and malformed/unrecognized tool
output. Existing prompt and full `AGENT_*` goldens remain unchanged. Observing
unsupported DSML spellings does not legalize or repair them.
