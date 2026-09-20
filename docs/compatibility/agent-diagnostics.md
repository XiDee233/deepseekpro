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

Message visibility is observed through `message_visibility`, with `messageId`,
`hidden` and a fixed reason. Live continuation hiding uses native request-message
IDs reported by the web provider, scoped to the current conversation/lifecycle.
History placeholders must occupy the entire message outside code/editable
content. Assistant bodies and quoted prompt tags are never hiding evidence.
Reconciliation restores old plugin-hidden replies and recycled DOM nodes; it
does not clear display rules without the plugin's own hidden marker. History
cleanup likewise excludes typed assistant messages from internal-request
classification. No message identity or visibility state is newly persisted.

New fields never contain full prompts/responses, tool arguments/commands/output,
file contents, credentials or grant IDs. Tool-runtime exports use metadata
instead of previous output/error snippets. This is an operational trace, not a
replay transcript. IDs are still sensitive correlation metadata.

Tests cover decoding, export, privacy, failed delivery, every protocol split,
actual first-turn branches, loop decisions and malformed/unrecognized tool
output. Existing prompt and full `AGENT_*` goldens remain unchanged. Observing
unsupported DSML spellings does not legalize or repair them.

## Input during an active run

The document lifecycle permanently replaces the native send control with a DOM
clone in the same slot; the original stays hidden and inert even when idle or
after a run finishes. CSS also hides newly rendered native send controls before
the mutation observer replaces them. A window-capture guard starts synchronously
at document_start. Idle clone clicks delegate exactly one click to the hidden
native control, preserving the site's normal send handler and disabled state.
The first advertised continuable tool acquires the pending-input session, before
waiting for tools, persistence or the assistant DOM anchor. The same queue then
passes to the loop and stays owned until its executor settles. Failed startup
or an aborted first response releases the queue and restores unsent text only
in the same conversation. Releasing a queue never removes the cloned button.
Enter and the replacement send button add after-task input to the bounded queue;
IME confirmation and Shift+Enter remain ordinary editing. Pending cards above
the composer provide Steer (next-turn delivery) and Remove actions. Admission
failure leaves the composer unchanged.
Input currently supports text only; existing grants and advertised tools are
not expanded by an insertion.

Steering enters the next provider turn; after-task input uses pi's follow-up
hook. The web backend includes newly admitted text in an optional `user_input`
block alongside the original task and tool results, using the latest server
response ID as parent. The official API retains the user-role input in its pi
transcript. The inserted text is not re-added on every subsequent web turn.
Without inserted input, the released continuation prompt bytes are unchanged.

With a pending-input session, a step-budget or exhausted-nudge pause waits in
the same loop for user steering. No native page request is sent by Continue,
and the loop context and server parent are retained. A new user input opens a
new bounded step allowance; queued after-task items alone cannot repeatedly
unlock budget pauses. Stop aborts the waiter and the run. Existing grant expiry
remains enforced; pausing does not extend tool permissions. Refresh/navigation
does not persist or resume pi state.

`user_input_queued`, `user_input_submitted`, `user_input_failed`, `loop_paused`
and `loop_resumed` record counts and `parentMessageId`, never input text.
`composer_owned` records the replacement button count at ownership acquisition;
`user_input_intercepted` records keyboard/button/form and admission success.
`send_button_replaced` records changes in clone count, including added/removed
controls after a React redraw. `composer_send_routed` distinguishes delegation
to the normal native handler, queue admission and a blocked submission. These
records contain no message text; a native route records delegation, not server
acceptance. Ordinary idle textarea key handling remains owned by the site.
Continuation requests containing inserted user text keep that text visible in
the native user-message body. Live rendering uses the request message ID and
its in-memory input text; history cleanup extracts only the trailing user-input
block from the server's continuation prompt. Internal tool results remain hidden.
`message_visibility` with `user_input_visible` records live restoration and the
input length without logging the text. No new storage keys or wire bytes are added.
On the web backend only input whose completion was never dispatched returns
to the queue. A server request-message ID commits delivery independently of
response completion. Dispatched input without a receipt is ambiguous: it is
shown in the run error, never automatically requeued or restored to the draft.
Completion requests are never automatically replayed, including no-output
network failures. Disposal restores genuinely unsent text to the composer
only when still on the owning conversation. Late sends during final
cleanup are rejected without clearing the draft. A draft/queued input prevents
automatic history reload from discarding it.

`model_request` means turn preparation. `model_request_dispatched` is emitted
at the actual fetch boundary; its `toolCount` counts newly transmitted results.
`model_request_accepted` binds the server user and assistant message IDs as soon
as the SSE codec observes them, even if reading the response later fails.
For inserted text, `inputSeq` together with request/loop identity links
`user_input_queued`, `user_input_submitted`, `user_input_accepted` and
`user_input_uncertain`. No text is included in diagnostic events. There is one
completion attempt per turn (`attempt: 1`). The existing diagnostic buffer is
still in-memory and does not survive a worker restart.

Web continuations send only results not yet acknowledged on that server chain.
The complete execution list stays available for the run display and accounting;
official API transcript serialization is unchanged. For example, 103 searches
followed by memory_update send 103 search records, then only the memory result.
The composer clone shows Stop for an active task with an empty draft, and Send
for additional text. Stop uses the existing run abort; during first-turn tools
it stops native generation when available and prevents automatic continuation.
Button rendering compares the owned render state rather than serialized SVG
innerHTML. Its observer ignores owned DOM and assistant/tool output, and only
reconciles composer changes. An empty pending-input dock performs no geometry
reads. Content diagnostics follow the document's extension-context lifecycle.
