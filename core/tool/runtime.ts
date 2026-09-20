import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { appendToolCallHistory } from './history';
import { ToolPostEffectPersistenceError } from './execution-error';
import type {
  RuntimeToolAuthorizationContext,
  ToolCall,
  ToolCapabilityScope,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
} from './types';
import type { ToolProviderRegistry } from './provider-registry';
import {
  isExternalizedToolPayload,
  parseExternalizedToolPayload,
  takeExternalizedToolPayloadText,
} from './externalized-payload';
import { isToolCallRecord } from '../messaging/tool-record-codec';
import { diagnosticLogBuffer } from '../diagnostics/log-buffer';
import { toolDiagnosticMetadata } from '../diagnostics/tool-metadata';
import {
  authorizeToolExecution,
  completeToolExecutionAuthorization,
  createToolAuthorizationResult,
  getGrantLocalSkillDir,
  getToolAuthorizationAuditTrigger,
  ToolAuthorizationError,
} from './authorization';
import { enforceLocalSkillCwd } from './local-skill-cwd';

export interface RuntimeToolCallOptions {
  timeoutMs?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
  assertActive?: () => void;
  /** Stable, background-owned scope for a multi-step trusted run. */
  trustedCapabilityScopeId?: string;
}

export interface RuntimeCapabilityInvocationInput {
  call: ToolCall;
  descriptor: ToolDescriptor;
  capabilityScope: ToolCapabilityScope;
  currentDescriptors: readonly ToolDescriptor[];
}

export type RuntimeCapabilityInvocationResolution =
  | { kind: 'target'; call: ToolCall; descriptor: ToolDescriptor }
  | { kind: 'rejected'; result: ToolResult };

/**
 * A deliberately narrow port for proxy-style capability calls. The runtime
 * owns normal tool authorization and provider dispatch; the injected resolver
 * may only map an already-authorized control call to one live target.
 */
export interface RuntimeCapabilityInvocationResolver {
  supports(descriptor: ToolDescriptor): boolean;
  resolveInvocation(
    input: RuntimeCapabilityInvocationInput,
  ): Promise<RuntimeCapabilityInvocationResolution>;
}

export interface RuntimeToolRuntimeOptions {
  capabilityInvocationResolver?: RuntimeCapabilityInvocationResolver;
}

export interface RuntimeToolRuntime {
  getToolDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  getAuthorizationDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  refreshToolDescriptors(locale?: SupportedLocale): Promise<ToolDescriptor[]>;
  executeToolCall(
    call: ToolCall,
    authorization: RuntimeToolAuthorizationContext | ToolExecutionTrigger,
    locale?: SupportedLocale,
    options?: RuntimeToolCallOptions,
  ): Promise<ToolResult>;
}

export function createRuntimeToolRuntime(
  providerRegistry: ToolProviderRegistry,
  runtimeOptions: RuntimeToolRuntimeOptions = {},
): RuntimeToolRuntime {
  return {
    getToolDescriptors: (locale = DEFAULT_LOCALE) => getRuntimeDescriptors(
      providerRegistry,
      locale,
      false,
    ),
    getAuthorizationDescriptors: (locale = DEFAULT_LOCALE) => getRuntimeDescriptors(
      providerRegistry,
      locale,
      true,
    ),
    refreshToolDescriptors: async (locale = DEFAULT_LOCALE) => {
      await providerRegistry.refresh({ locale });
      return getRuntimeDescriptors(providerRegistry, locale, false);
    },
    executeToolCall: (call, authorization, locale = DEFAULT_LOCALE, callOptions = {}) =>
      executeRuntimeToolCall(
        providerRegistry,
        call,
        authorization,
        locale,
        callOptions,
        runtimeOptions.capabilityInvocationResolver,
      ),
  };
}

async function getRuntimeDescriptors(
  providerRegistry: ToolProviderRegistry,
  locale: SupportedLocale,
  includeDisabledMcp: boolean,
): Promise<ToolDescriptor[]> {
  return providerRegistry.listTools({
    locale,
    includeDisabled: includeDisabledMcp,
  });
}

async function executeRuntimeToolCall(
  providerRegistry: ToolProviderRegistry,
  call: ToolCall,
  authorization: RuntimeToolAuthorizationContext | ToolExecutionTrigger,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options: RuntimeToolCallOptions = {},
  capabilityInvocationResolver?: RuntimeCapabilityInvocationResolver,
): Promise<ToolResult> {
  assertRuntimeExecutionActive(options);
  const diagnosticStartedAt = Date.now();
  const identifiedCall = !call.id && options.idempotencyKey
    ? { ...call, id: options.idempotencyKey }
    : call;
  if (!isToolCallRecord(identifiedCall)) {
    diagnosticLogBuffer.record({
      level: 'warn',
      source: 'tool-runtime',
      message: 'tool call payload rejected',
    });
    return createInvalidToolCallResult(identifiedCall, locale);
  }
  const context = typeof authorization === 'string'
    ? createTrustedExecutionContext(identifiedCall, authorization, options.trustedCapabilityScopeId)
    : authorization;
  diagnosticLogBuffer.record({
    level: 'info',
    source: 'tool-runtime',
    message: `tool start: ${identifiedCall.name}`,
    details: toolDiagnosticMetadata(identifiedCall),
  });
  if (identifiedCall.parseError) {
    const result = createParseErrorToolResult(identifiedCall, locale);
    diagnosticLogBuffer.record({ level: 'warn', source: 'tool-runtime', message: 'tool parse rejected',
      details: toolDiagnosticMetadata(identifiedCall, result, Date.now() - diagnosticStartedAt) });
    await appendAuthorizedFailureHistory(identifiedCall, result, context);
    return result;
  }
  let authorized: Awaited<ReturnType<typeof authorizeToolExecution>>;
  let currentDescriptors: ToolDescriptor[];
  try {
    currentDescriptors = await getRuntimeDescriptors(providerRegistry, locale, true);
    authorized = await authorizeToolExecution(
      identifiedCall,
      context,
      currentDescriptors,
    );
    assertRuntimeExecutionActive(options);
  } catch (error) {
    if (!(error instanceof ToolAuthorizationError)) throw error;
    const result = error.code === 'tool_unsupported'
      ? createUnsupportedToolResult(identifiedCall, locale)
      : createToolAuthorizationResult(
        error,
        identifiedCall,
        translate(locale, 'tool.runtime.authorizationRejected'),
        buildAuthorizationRejectionHint(locale, error),
      );
    diagnosticLogBuffer.record({
      level: 'warn',
      source: 'tool-runtime',
      message: `tool authorization denied: ${identifiedCall.name}`,
      details: toolDiagnosticMetadata(identifiedCall, result, Date.now() - diagnosticStartedAt),
    });
    await appendAuthorizedFailureHistory(identifiedCall, result, context);
    return result;
  }

  let result: ToolResult;
  let resolvedCall = authorized.call;
  let executionDescriptor = authorized.descriptor;
  let providerCompleted = false;
  try {
    resolvedCall = await resolveToolCallPayload(
      authorized.call,
      authorized.externalPayloadNamespace,
    );
    assertRuntimeExecutionActive(options);
    if (resolvedCall.parseError) {
      result = createParseErrorToolResult(resolvedCall, locale);
    } else if (capabilityInvocationResolver?.supports(executionDescriptor)) {
      const resolution = await capabilityInvocationResolver.resolveInvocation({
        call: resolvedCall,
        descriptor: executionDescriptor,
        capabilityScope: createRuntimeCapabilityScope(context, resolvedCall),
        currentDescriptors,
      });
      if (resolution.kind === 'rejected') {
        result = resolution.result;
      } else {
        resolvedCall = resolution.call;
        executionDescriptor = resolution.descriptor;
        result = await providerRegistry.execute(
          resolvedCall,
          executionDescriptor,
          {
            locale,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            maxResultBytes: options.maxResultBytes,
            availableDescriptors: currentDescriptors,
            capabilityScope: createRuntimeCapabilityScope(context, authorized.call),
          },
        );
        providerCompleted = true;
      }
    } else {
      result = await providerRegistry.execute(
        resolvedCall,
        executionDescriptor,
        {
          locale,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          maxResultBytes: options.maxResultBytes,
          availableDescriptors: currentDescriptors,
          capabilityScope: createRuntimeCapabilityScope(context, authorized.call),
        },
      );
      providerCompleted = true;
    }
    assertRuntimeExecutionActive(options);
  } catch (error) {
    diagnosticLogBuffer.record({
      level: 'error',
      source: 'tool-runtime',
      message: `tool execution failed: ${resolvedCall.name}`,
      details: toolDiagnosticMetadata(resolvedCall, undefined, Date.now() - diagnosticStartedAt, error),
    });
    await completeAuthorizationAfterProvider(authorized.reservation);
    throw error;
  }
  await completeAuthorizationAfterProvider(authorized.reservation, result);
  try {
    await appendRuntimeToolHistory(resolvedCall, result, authorized.trigger);
  } catch (error) {
    diagnosticLogBuffer.record({ level: 'error', source: 'tool-runtime', message: 'tool history write failed',
      details: toolDiagnosticMetadata(resolvedCall, result, Date.now() - diagnosticStartedAt) });
    if (providerCompleted) throw new ToolPostEffectPersistenceError(error);
    throw error;
  }
  assertRuntimeExecutionActive(options);
  diagnosticLogBuffer.record({
    level: result.ok ? 'info' : 'warn',
    source: 'tool-runtime',
    message: `tool finished: ${result.name ?? resolvedCall.name} (${result.ok ? 'ok' : 'error'})`,
    details: toolDiagnosticMetadata(resolvedCall, result, Date.now() - diagnosticStartedAt),
  });
  return result;
}

export function createInvalidToolCallResult(
  value: unknown,
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolResult {
  const message = 'Runtime tool call does not match the released contract.';
  const name = value && typeof value === 'object'
    && typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : undefined;
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.invalidFormat'),
    detail: message,
    name,
    error: {
      code: 'tool_call_payload_invalid',
      message,
      retryable: false,
    },
  };
}

function assertRuntimeExecutionActive(options: RuntimeToolCallOptions): void {
  options.assertActive?.();
  if (!options.signal?.aborted) return;
  const reason = options.signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('Tool execution was aborted.', 'AbortError');
}

async function appendAuthorizedFailureHistory(
  call: ToolCall,
  result: ToolResult,
  context: RuntimeToolAuthorizationContext,
): Promise<void> {
  const trigger = await getToolAuthorizationAuditTrigger(call, context);
  if (trigger) await appendRuntimeToolHistory(call, result, trigger);
}

async function completeAuthorizationAfterProvider(
  reservation: Awaited<ReturnType<typeof authorizeToolExecution>>['reservation'],
  result?: ToolResult,
): Promise<void> {
  try {
    await completeToolExecutionAuthorization(reservation, result);
  } catch (error) {
    // The executing reservation was persisted before provider I/O, so a failed
    // completion write remains fail-closed for replay. Preserve the real
    // provider result and history instead of replacing it with a storage error.
    console.error('[DeepSeek++] tool authorization completion persistence failed', error);
  }
}

async function appendRuntimeToolHistory(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): Promise<void> {
  try {
    await appendToolCallHistory(call, result, source);
  } catch (error) {
    if (!isRecoverableToolHistoryError(error)) throw error;
    console.warn('[DeepSeek++] tool history persistence failed', error);
  }
}

export async function resolveToolCallPayload(
  call: ToolCall,
  externalPayloadNamespace?: string,
): Promise<ToolCall> {
  // Review #2: cwd is derived solely from the grant owned by background,
  // ignoring any page/model-supplied call.localSkillDir (untrusted).
  // externalPayloadNamespace is the grant.id, emitted uniformly by the
  // authorization layer (authorization.ts:227); both the normal branch and the
  // externalized branch share the same derived directory.
  const grantLocalSkillDir = externalPayloadNamespace
    ? await getGrantLocalSkillDir(externalPayloadNamespace)
    : undefined;

  if (!isExternalizedToolPayload(call.payload)) {
    // Normal XML / legacy DSML path (the most common execution route): inject
    // the initial cwd hint. Do not re-trust any call-supplied field.
    return {
      ...call,
      payload: enforceLocalSkillCwd(call.payload, call.invocationName ?? '', grantLocalSkillDir),
    };
  }

  const body = takeExternalizedToolPayloadText(
    call.payload.ref,
    call.payload.invocationName,
    externalPayloadNamespace,
  );
  if (body === null) {
    return {
      ...call,
      payload: {},
      parseError: {
        code: 'tool_call_external_payload_missing',
        message: 'Tool call payload expired before execution completed. Retry the request.',
        retryable: true,
        details: { invocationName: call.payload.invocationName },
      },
    };
  }

  const resolved = parseExternalizedToolPayload(body, call.payload.invocationName, grantLocalSkillDir);
  if (resolved.parseError) {
    return {
      ...call,
      payload: {},
      parseError: resolved.parseError,
    };
  }

  return {
    ...call,
    payload: resolved.payload ?? {},
    parseError: undefined,
  };
}

function isRecoverableToolHistoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /QUOTA_BYTES|quota exceeded|max(?:imum)?\s+(?:write|storage)|too large/i.test(message);
}

function createParseErrorToolResult(call: ToolCall, locale: SupportedLocale): ToolResult {
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.invalidFormat'),
    detail: call.parseError?.message ?? 'Tool call payload is invalid.',
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    error: call.parseError ?? {
      code: 'tool_call_payload_invalid',
      message: 'Tool call payload is invalid.',
      retryable: false,
    },
  };
}

function createUnsupportedToolResult(call: ToolCall, locale: SupportedLocale): ToolResult {
  return {
    ok: false,
    summary: translate(locale, 'tool.runtime.unknownTool'),
    detail: `Unsupported tool: ${call.name}`,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    error: {
      code: 'tool_unsupported',
      message: `Unsupported tool: ${call.name}`,
      retryable: false,
    },
  };
}

function createTrustedExecutionContext(
  call: ToolCall,
  trigger: ToolExecutionTrigger,
  capabilityScopeId?: string,
): RuntimeToolAuthorizationContext {
  return {
    kind: 'trusted',
    trigger,
    requestId: call.source?.requestId ?? crypto.randomUUID(),
    capabilityScopeId,
    chatSessionId: call.source?.chatSessionId ?? null,
    taskId: call.source?.taskId,
    runId: call.source?.runId,
    automationId: call.source?.automationId,
    automationRunId: call.source?.automationRunId,
  };
}

function createRuntimeCapabilityScope(
  context: RuntimeToolAuthorizationContext,
  canonicalCall: ToolCall,
): ToolCapabilityScope {
  if (context.kind === 'grant') {
    const source = canonicalCall.source;
    if (!source?.requestId) {
      throw new Error('Granted capability scope is missing its authorized request identity.');
    }
    return {
      kind: 'grant',
      scopeId: source.requestId,
      trigger: source.trigger,
      chatSessionId: source.chatSessionId ?? null,
      subject: { ...context.subject },
    };
  }
  return {
    kind: 'trusted',
    scopeId: context.capabilityScopeId ?? context.requestId,
    trigger: context.trigger,
    chatSessionId: context.chatSessionId ?? null,
  };
}


type AuthorizationHintKey =
  | 'tool.runtime.authorizationMissingHint'
  | 'tool.runtime.authorizationStaleHint'
  | 'tool.runtime.authorizationSessionMismatchHint'
  | 'tool.runtime.authorizationDisabledHint'
  | 'tool.runtime.authorizationIdentityMissingHint'
  | 'tool.runtime.authorizationGenericHint';

function buildAuthorizationRejectionHint(
  locale: SupportedLocale,
  error: ToolAuthorizationError,
): string {
  return translate(locale, authorizationHintKey(error.code), {});
}

function authorizationHintKey(code: string): AuthorizationHintKey {
  switch (code) {
    case 'tool_authorization_missing':
      return 'tool.runtime.authorizationMissingHint';
    case 'tool_authorization_stale':
      return 'tool.runtime.authorizationStaleHint';
    case 'tool_session_mismatch':
      return 'tool.runtime.authorizationSessionMismatchHint';
    case 'tool_disabled':
      return 'tool.runtime.authorizationDisabledHint';
    case 'tool_identity_missing':
      return 'tool.runtime.authorizationIdentityMissingHint';
    default:
      return 'tool.runtime.authorizationGenericHint';
  }
}
