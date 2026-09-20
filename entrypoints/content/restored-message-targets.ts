const RESTORED_EXTENSION_UI_SELECTOR = [
  '.dpp-tool-block',
  '.dpp-agent-container',
  '.dpp-artifact-results',
].join(', ');

export interface RestoredMessageMutationAction {
  readonly requeueMountedRecords: boolean;
  readonly schedulePendingRender: boolean;
}

export function getRestoredMessageMutationAction(
  mutations: readonly MutationRecord[],
  options: {
    readonly hasPendingRecords: boolean;
    readonly restoredUiSelector: string;
  },
): RestoredMessageMutationAction {
  const requeueMountedRecords = mutations.some((mutation) =>
    mutationMayInvalidateRestoredMessageUi(mutation, options.restoredUiSelector));
  const schedulePendingRender = requeueMountedRecords || (
    options.hasPendingRecords && mutations.some(mutationMayAffectRestoredMessageTarget)
  );

  return { requeueMountedRecords, schedulePendingRender };
}

export function mutationMayAffectRestoredMessageTarget(
  mutation: MutationRecord,
): boolean {
  if (isAssistantMessageIdentityMutation(mutation)) return true;
  if (mutation.type === 'characterData') {
    return nodeMayAffectRestoredMessageTarget(mutation.target);
  }

  return Array.from(mutation.addedNodes)
    .some(nodeMayAffectRestoredMessageTarget);
}

function nodeMayAffectRestoredMessageTarget(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || element.closest(RESTORED_EXTENSION_UI_SELECTOR)) return false;

  return element.matches('.ds-message') ||
    Boolean(element.closest('.ds-message')) ||
    Boolean(element.querySelector('.ds-message'));
}

function mutationMayInvalidateRestoredMessageUi(
  mutation: MutationRecord,
  restoredUiSelector: string,
): boolean {
  if (isAssistantMessageIdentityMutation(mutation)) return true;
  if (mutation.type !== 'childList') return false;

  return Array.from(mutation.addedNodes).some(nodeMountsMessage) ||
    Array.from(mutation.removedNodes).some((node) => nodeMatchesOrContains(node, restoredUiSelector));
}

function nodeMountsMessage(node: Node): boolean {
  return node instanceof Element && (
    node.matches('.ds-message') || Boolean(node.querySelector('.ds-message'))
  );
}

function nodeMatchesOrContains(node: Node, selector: string): boolean {
  return node instanceof Element && (
    node.matches(selector) || Boolean(node.querySelector(selector))
  );
}
import { isAssistantMessageIdentityMutation } from '../../core/inline-agent/message-anchor';
