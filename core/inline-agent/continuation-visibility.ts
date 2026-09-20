import { INLINE_AGENT_CONTINUATION_PLACEHOLDER } from './prompt';
import { readAssistantMessageIdentity, isAssistantMessageIdentityMutation } from './message-anchor';

export const HIDDEN_CONTINUATION_ATTRIBUTE = 'data-dpp-hidden-inline-agent-continuation';
export interface ContinuationVisibilityDecision {
  hidden: boolean;
  reason: 'owned_continuation' | 'continuation_placeholder' | 'assistant_visible' | 'ordinary_visible' | 'user_input_visible';
  userText?: string;
}

/** Content is not identity: quoted prompts and code examples remain visible. */
export function decideContinuationVisibility(
  message: HTMLElement, ownedRequestMessageIds: ReadonlyMap<string, string>,
): ContinuationVisibilityDecision {
  const role = message.getAttribute('data-message-role') ?? message.getAttribute('data-role');
  if (role?.toLowerCase() === 'assistant'
    || message.querySelector('.ds-assistant-message-main-content')) {
    return { hidden: false, reason: 'assistant_visible' };
  }
  const identity = readAssistantMessageIdentity(message);
  if (identity && ownedRequestMessageIds.has(identity.id)) {
    const userText = ownedRequestMessageIds.get(identity.id);
    if (userText) return { hidden: false, reason: 'user_input_visible', userText };
    return { hidden: true, reason: 'owned_continuation' };
  }
  // History cleanup replaces a complete internal request with this reserved
  // marker. Merely mentioning it inside a reply or code block is insufficient.
  if (message.textContent?.trim() === INLINE_AGENT_CONTINUATION_PLACEHOLDER
    && !message.querySelector('pre, code, textarea, input, [contenteditable="true"]')) {
    return { hidden: true, reason: 'continuation_placeholder' };
  }
  return { hidden: false, reason: 'ordinary_visible' };
}

export function getContinuationMessageCandidates(root: ParentNode): HTMLElement[] {
  const candidates = new Set<HTMLElement>();
  if (root instanceof Element) {
    const enclosing = root.closest<HTMLElement>('.ds-message');
    if (enclosing) candidates.add(enclosing);
  }
  for (const message of root.querySelectorAll<HTMLElement>('.ds-message')) candidates.add(message);
  return [...candidates];
}

export function reconcileContinuationVisibility(
  root: ParentNode,
  ownedRequestMessageIds: ReadonlyMap<string, string>,
  onChange?: (message: HTMLElement, decision: ContinuationVisibilityDecision) => void,
): void {
  for (const message of getContinuationMessageCandidates(root)) {
    const decision = decideContinuationVisibility(message, ownedRequestMessageIds);
    const wasHidden = message.hasAttribute(HIDDEN_CONTINUATION_ATTRIBUTE);
    let textChanged = false;
    if (decision.userText !== undefined) {
      const body = message.querySelector<HTMLElement>('.ds-collapsible-text') ?? message;
      if (body.textContent !== decision.userText) {
        body.textContent = decision.userText;
        body.style.whiteSpace = 'pre-wrap';
        textChanged = true;
      }
    }
    if (decision.hidden) {
      const needsStyle = message.style.display !== 'none';
      if (!wasHidden) message.setAttribute(HIDDEN_CONTINUATION_ATTRIBUTE, 'true');
      if (needsStyle) message.style.display = 'none';
      if (!wasHidden || needsStyle) onChange?.(message, decision);
    } else if (wasHidden) {
      // Undo only hiding owned by this feature, including markers left by an
      // older extension build or a React-recycled message node.
      message.removeAttribute(HIDDEN_CONTINUATION_ATTRIBUTE);
      message.style.removeProperty('display');
      onChange?.(message, decision);
    } else if (textChanged) {
      onChange?.(message, decision);
    }
  }
}

export function mutationMayAffectContinuationVisibility(mutation: MutationRecord): boolean {
  if (isAssistantMessageIdentityMutation(mutation)) return true;
  const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (element?.closest('.dpp-agent-container, .dpp-tool-block, .dpp-artifact-results')) return false;
  if (element?.closest('.ds-message')) return true;
  return Array.from(mutation.addedNodes).some((node) => node instanceof Element
    && (node.matches('.ds-message') || Boolean(node.querySelector('.ds-message'))));
}
