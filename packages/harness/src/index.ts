export { computePayloadHash, computeTerminalDigest } from "./protocol.js";
export { normalizeVisibleMessage, sanitizeMessage, splitUtf8Chunks } from "./sanitize.js";
export type {
  NormalizedVisibleMessage,
  SanitizeMessageOptions,
  VisibleMessage,
} from "./sanitize.js";
export {
  assertSafePathComponent,
  ensureSecureHarnessPaths,
  inspectFilesystemCapabilities,
  withAdvisoryLock,
  withExclusiveFileLock,
} from "./fs-security.js";
export {
  enqueueEventCancellation,
  enqueueSessionEnd,
  enqueueSessionStart,
  enqueueTurnRetraction,
  enqueueVisibleMessage,
  OutboxDurabilityError,
  quarantineUndeliverableEvent,
  readPendingEvents,
  replaceUnseenWithLoss,
} from "./outbox.js";
export type {
  EnqueueResult,
  EnqueueEventCancellationInput,
  EnqueueSessionEndInput,
  EnqueueSessionStartInput,
  EnqueueTurnRetractionInput,
  EnqueueVisibleMessageInput,
  HarnessOutboxEvent,
  OutboxOptions,
} from "./outbox.js";
export {
  acknowledgeEvent,
  compactTerminalState,
  readSessionState,
  recoverNextSequence,
  writeGenerationMapping,
} from "./state.js";
export type {
  AcknowledgedEvent,
  AcknowledgedMessageChunkState,
  HarnessTurnAppendChunk,
  MessageIdentity,
  SessionState,
  SessionStateResult,
  StateOptions,
} from "./state.js";
export { keyFingerprint, readBinding, resolveBinding } from "./binding.js";
export { clearCaptureConsent, readCaptureConsent, writeCaptureConsent } from "./consent.js";
export type { CaptureConsent, CaptureConsentInput } from "./consent.js";
export type { BindingInput, BindingOptions, BindingResolution, HarnessBinding } from "./binding.js";
export { clearDeliveryBackoff, flushOutbox, readDeliveryState } from "./delivery.js";
export type {
  DeliveryState,
  DeliveryTransport,
  FlushOptions,
  FlushResult,
  TransportResponse,
} from "./delivery.js";
export { planReconciliation } from "./reconcile.js";
export type {
  PlannedAppend,
  PlannedCancellation,
  PlannedRetraction,
  ReconciliationInput,
  ReconciliationPlan,
  TerminalMember,
  TranscriptMessage,
} from "./reconcile.js";
export { diagnoseHarness } from "./doctor.js";
export type {
  DoctorOptions,
  DoctorReport,
  HostCaptureDiagnosis,
  HostCaptureProbe,
} from "./doctor.js";
export {
  OPENCODE_CHANNELS,
  OPENCODE_SESSION_EVENTS,
  buildManagedMarker,
  toTranscriptMessages,
  toVisibleMessage,
  validateManagedMarker,
} from "./adapters/opencode.js";
export type { VisibleMessageInput } from "./adapters/opencode.js";
export {
  computeCaptureArtifactHash,
  resolveCaptureMode,
  resolveHostCaptureMode,
} from "./adapters/capabilities.js";
export type {
  CaptureDecision,
  CaptureHost,
  CaptureMode,
  QualificationRecord,
} from "./adapters/capabilities.js";
export { readHostVersion } from "./host-version.js";
export type {
  HostVersionEffects,
  HostVersionResult,
  HostVersionSpawn,
  HostVersionSpawnResult,
} from "./host-version.js";
export {
  CLAUDE_CODE_EVENTS,
  isSessionClose,
  toTranscriptMessages as toClaudeTranscriptMessages,
  toVisibleMessage as toClaudeVisibleMessage,
} from "./adapters/claude-code.js";
export type { ClaudeCodeEvent, ClaudeVisibleMessage } from "./adapters/claude-code.js";
export {
  CODEX_EVENTS,
  codexCaptureGate,
  hookResponse as codexHookResponse,
  isSessionClose as isCodexSessionClose,
  toVisibleMessage as toCodexVisibleMessage,
} from "./adapters/codex.js";
export type { CodexCaptureGate, CodexEvent, CodexVisibleMessage } from "./adapters/codex.js";
export { captureLegacyHook, drainLegacySpools } from "./legacy-capture.js";
export type { LegacyHookPayload, LegacyCaptureOptions } from "./legacy-capture.js";
export {
  captureHostHook,
  createFetchDeliveryTransport,
  discardHarnessQueue,
  drainHarnessQueue,
  listHarnessQueue,
  probeHarnessServer,
  quiesceHarnessWorkspace,
  readClaudeTranscript,
  readHarnessLifecycleState,
  releaseHarnessRetry,
  removeHostHarnessArtifacts,
  resolveClaudeAllowedRoot,
  resolveHarnessCredentials,
} from "./host-runtime.js";
export type {
  CaptureHostHookInput,
  CaptureHostHookResult,
  ClaudeTranscriptRawEntry,
  ProvisionalPromptEntry,
  ResolvedHarnessCredentials,
  SafeTranscriptOptions,
  SafeTranscriptResult,
  SessionRuntimeRecord,
} from "./host-runtime.js";
