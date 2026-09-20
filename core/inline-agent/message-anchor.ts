/** Message identity belongs to its native envelope, never generated markdown. */
export const ASSISTANT_MESSAGE_ID_ATTRIBUTES = [
  'data-message-id', 'data-messageid', 'data-ds-message-id', 'data-id',
  'data-virtual-list-item-key', 'id',
] as const;

export interface AssistantMessageIdentity {
  id: string;
  source: 'message_attribute' | 'virtual_item_key';
}

function readEnvelopeIds(element: Element): AssistantMessageIdentity[] {
  const result: AssistantMessageIdentity[] = [];
  for (const attribute of ASSISTANT_MESSAGE_ID_ATTRIBUTES) {
    const raw = element.getAttribute(attribute);
    if (!raw) continue;
    const value = attribute === 'id' || attribute === 'data-id'
      ? /^(?:(?:ds-message|message|msg)[-_])?([1-9]\d*)$/.exec(raw)?.[1] : raw;
    if (value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
      result.push({ id: value, source: attribute === 'data-virtual-list-item-key'
        ? 'virtual_item_key' : 'message_attribute' });
    }
  }
  return result;
}

export function readAssistantMessageIdentity(message: Element): AssistantMessageIdentity | null {
  const identities = readEnvelopeIds(message);
  const row = message.parentElement;
  // Only this message's owning virtual-list row. No arbitrary ancestors or
  // descendants: Mermaid/code ids such as flowchart-WB1-12 are not message ids.
  if (row?.hasAttribute('data-virtual-list-item-key')
    && row.querySelectorAll('.ds-message').length === 1
    && row.querySelector('.ds-message') === message) {
    identities.push(...readEnvelopeIds(row));
  }
  if (!identities.length || new Set(identities.map(({ id }) => id)).size !== 1) return null;
  return identities[0];
}

export function elementHasMessageId(message: Element, messageId: string): boolean {
  return readAssistantMessageIdentity(message)?.id === messageId;
}

export interface InlineAgentTargetDecision {
  target: Element | null;
  reason: 'anchor_matched' | 'anchor_missing' | 'anchor_ambiguous' | 'anchor_claimed';
  source?: AssistantMessageIdentity['source'];
  candidateCount: number;
}

/** Single locator for live and restored runs. Missing identity waits. */
export function resolveInlineAgentTarget(
  anchorMessageId: number, messages: readonly Element[], claimed: ReadonlySet<Element>,
): InlineAgentTargetDecision {
  const matches = messages.filter((message) => elementHasMessageId(message, String(anchorMessageId)));
  if (matches.length !== 1) return { target: null,
    reason: matches.length > 1 ? 'anchor_ambiguous' : 'anchor_missing', candidateCount: matches.length };
  if (claimed.has(matches[0])) return { target: null, reason: 'anchor_claimed', candidateCount: 1 };
  return { target: matches[0], reason: 'anchor_matched', candidateCount: 1,
    source: readAssistantMessageIdentity(matches[0])!.source };
}

/** Revalidate the binding immediately before DOM mutation. */
export function placeInlineAgentContainer(
  anchorMessageId: number, message: Element, responseHost: Element, container: HTMLElement,
): 'mounted' | 'unchanged' | 'identity_changed' {
  if (!elementHasMessageId(message, String(anchorMessageId))
    || (responseHost !== message && !message.contains(responseHost))) return 'identity_changed';
  if (container.parentElement === responseHost && !container.nextSibling) return 'unchanged';
  responseHost.appendChild(container);
  return 'mounted';
}

export function isAssistantMessageIdentityMutation(mutation: MutationRecord): boolean {
  if (mutation.type !== 'attributes' || !mutation.attributeName
    || !ASSISTANT_MESSAGE_ID_ATTRIBUTES.includes(mutation.attributeName as typeof ASSISTANT_MESSAGE_ID_ATTRIBUTES[number])) return false;
  const target = mutation.target;
  return target instanceof Element && (target.matches('.ds-message')
    || Boolean(target.querySelector(':scope > .ds-message')));
}
