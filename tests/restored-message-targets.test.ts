import { describe, expect, it } from 'vitest';
import {
  getRestoredMessageMutationAction,
  mutationMayAffectRestoredMessageTarget,
} from '../entrypoints/content/restored-message-targets';

describe('restored message target mutations', () => {
  it('requeues a mounted trace when the virtual row is recycled without replacing its children', () => {
    const row = document.createElement('div');
    row.setAttribute('data-virtual-list-item-key', '18');
    row.innerHTML = '<div class="ds-message"><div class="dpp-agent-container"></div></div>';
    const mutation = { type: 'attributes', target: row, attributeName: 'data-virtual-list-item-key' } as unknown as MutationRecord;
    expect(getRestoredMessageMutationAction([mutation], {
      hasPendingRecords: false, restoredUiSelector: '.dpp-agent-container',
    })).toEqual({ requeueMountedRecords: true, schedulePendingRender: true });
  });
  it('detects newly mounted messages and content added inside an existing message', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const content = document.createElement('div');
    message.appendChild(content);

    expect(mutationMayAffectRestoredMessageTarget(childListMutation(document.body, message)))
      .toBe(true);
    expect(mutationMayAffectRestoredMessageTarget(childListMutation(message, content)))
      .toBe(true);
  });

  it('detects late text rendering inside a message', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const text = document.createTextNode('Late assistant content');
    message.appendChild(text);

    expect(mutationMayAffectRestoredMessageTarget(characterDataMutation(text))).toBe(true);
  });

  it('ignores extension-owned restored UI so rendering does not reschedule itself', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const toolBlock = document.createElement('div');
    toolBlock.className = 'dpp-tool-block';
    const toolItem = document.createElement('span');
    toolBlock.appendChild(toolItem);
    message.appendChild(toolBlock);

    expect(mutationMayAffectRestoredMessageTarget(childListMutation(message, toolBlock)))
      .toBe(false);
    expect(mutationMayAffectRestoredMessageTarget(childListMutation(toolBlock, toolItem)))
      .toBe(false);
  });

  it('does not schedule a full restore for ordinary streaming text after pending records finish', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const text = document.createTextNode('Streaming assistant content');
    message.appendChild(text);

    expect(getRestoredMessageMutationAction([characterDataMutation(text)], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-tool-block',
    })).toEqual({
      requeueMountedRecords: false,
      schedulePendingRender: false,
    });
    expect(getRestoredMessageMutationAction([characterDataMutation(text)], {
      hasPendingRecords: true,
      restoredUiSelector: '.dpp-tool-block',
    })).toEqual({
      requeueMountedRecords: false,
      schedulePendingRender: true,
    });
  });

  it('requeues records when a message remounts or restored UI is removed', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const toolBlock = document.createElement('div');
    toolBlock.className = 'dpp-tool-block';

    expect(getRestoredMessageMutationAction([childListMutation(document.body, message)], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-tool-block',
    })).toEqual({
      requeueMountedRecords: true,
      schedulePendingRender: true,
    });
    expect(getRestoredMessageMutationAction([childListMutation(message, [], [toolBlock])], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-tool-block',
    })).toEqual({
      requeueMountedRecords: true,
      schedulePendingRender: true,
    });
  });
});

function childListMutation(
  target: Node,
  addedNodesOrFirstNode: Node[] | Node,
  removedNodes: Node[] = [],
): MutationRecord {
  const addedNodes = Array.isArray(addedNodesOrFirstNode)
    ? addedNodesOrFirstNode
    : [addedNodesOrFirstNode];
  return {
    type: 'childList',
    target,
    addedNodes: addedNodes as unknown as NodeList,
    removedNodes: removedNodes as unknown as NodeList,
  } as MutationRecord;
}

function characterDataMutation(target: Node): MutationRecord {
  return { type: 'characterData', target } as MutationRecord;
}
