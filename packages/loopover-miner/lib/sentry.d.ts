/** Opt-in Sentry error tracking for the miner CLI. Complete no-op unless LOOPOVER_MINER_SENTRY_DSN is set. */

/** Initialize Sentry from `env` (default `process.env`). Returns whether it activated. */
export function initMinerSentry(env?: Record<string, string | undefined>): Promise<boolean>;

/** Capture an error with optional structured context. No-op when Sentry is off. Never throws. */
export function captureMinerError(error: unknown, context?: Record<string, unknown>): void;

/** Flush buffered events before the process exits. No-op when off. */
export function flushMinerSentry(timeoutMs?: number): Promise<void>;

/** Capture AND flush before returning -- the crash-path convenience wrapper for
 *  installCliSignalHandlers' `captureError` hook. */
export function captureMinerErrorAndFlush(error: unknown, context?: Record<string, unknown>): Promise<void>;

/** Test-only: reset module state so one test's activation can't leak into the next. */
export function resetMinerSentryForTesting(): void;
