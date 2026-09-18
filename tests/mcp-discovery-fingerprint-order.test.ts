import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerStorageState } from '../core/mcp/types';
import { MCP_STORAGE_KEY } from '../core/mcp/storage-codec';
import { updateMcpServer } from '../core/mcp/store';
import { MCP_CACHE_ENTRY, MCP_SERVER_IDS, MCP_STORAGE_V2 } from './fixtures/persistence-contract/mcp';

/**
 * `chrome.storage` re-serializes persisted objects with alphabetically ordered
 * keys, while `normalizeServerForMutation` rebuilds them in declaration order.
 * A discovery fingerprint that compares those shapes field by field must not
 * care about the key order, otherwise one unchanged configuration yields two
 * fingerprints and every save drops the tool cache for that server.
 *
 * The stored fixture is key-sorted here to reproduce what the extension
 * actually reads back from `chrome.storage` (verified against a live profile:
 * `"timeouts":{"connectMs":…,"discoveryMs":…,"requestMs":…}`).
 */
function throughChromeStorage<T>(value: T): T {
  if (Array.isArray(value)) return value.map(throughChromeStorage) as unknown as T;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, throughChromeStorage(source[key])]),
    ) as T;
  }
  return value;
}

let storage: Record<string, unknown>;
let storageSet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = {};
  storageSet = vi.fn(async (values: Record<string, unknown>) => {
    storage = { ...storage, ...values };
  });
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fingerprint-order-id') });
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => Object.prototype.hasOwnProperty.call(storage, key)
          ? { [key]: storage[key] }
          : {}),
        set: storageSet,
        remove: vi.fn(),
      },
    },
    permissions: {
      contains: vi.fn(),
      request: vi.fn(),
    },
    runtime: { connectNative: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function persistedState(): McpServerStorageState {
  return storage[MCP_STORAGE_KEY] as McpServerStorageState;
}

describe('MCP discovery fingerprint is independent of persisted key order', () => {
  it('keeps the tool cache when only the allowlist changes', async () => {
    storage[MCP_STORAGE_KEY] = throughChromeStorage(structuredClone(MCP_STORAGE_V2));

    await updateMcpServer(MCP_SERVER_IDS.shell, {
      allowlist: { mode: 'allow', toolNames: ['shell_status', 'shell_exec'] },
    });

    const state = persistedState();
    expect(state.toolCaches.map((cache) => cache.serverId)).toEqual([MCP_SERVER_IDS.shell]);
    expect(state.toolCaches[0]).toEqual(MCP_CACHE_ENTRY);
    expect(state.servers.find((server) => server.id === MCP_SERVER_IDS.shell)?.allowlist.toolNames)
      .toEqual(['shell_status', 'shell_exec']);
  });

  it('marks the server as still connected when only the allowlist changes', async () => {
    storage[MCP_STORAGE_KEY] = throughChromeStorage(structuredClone(MCP_STORAGE_V2));

    await updateMcpServer(MCP_SERVER_IDS.shell, {
      allowlist: { mode: 'allow', toolNames: ['shell_status'] },
    });

    const server = persistedState().servers.find((item) => item.id === MCP_SERVER_IDS.shell);
    expect(server?.status).toBe('ready');
    expect(server?.lastConnectedAt).not.toBeNull();
  });

  it('still drops the tool cache when a discovery-affecting field changes', async () => {
    storage[MCP_STORAGE_KEY] = throughChromeStorage(structuredClone(MCP_STORAGE_V2));

    await updateMcpServer(MCP_SERVER_IDS.shell, {
      timeouts: { connectMs: 9_000, requestMs: 120_000, discoveryMs: 10_000 },
    });

    const state = persistedState();
    expect(state.toolCaches).toEqual([]);
    expect(state.servers.find((server) => server.id === MCP_SERVER_IDS.shell)?.status)
      .toBe('unknown');
  });

  it('still drops the tool cache when the tool cap changes', async () => {
    storage[MCP_STORAGE_KEY] = throughChromeStorage(structuredClone(MCP_STORAGE_V2));

    await updateMcpServer(MCP_SERVER_IDS.shell, {
      limits: { maxResultBytes: 128_000, maxToolCount: 32 },
    });

    expect(persistedState().toolCaches).toEqual([]);
  });
});
