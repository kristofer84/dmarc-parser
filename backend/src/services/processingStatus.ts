/**
 * Tracks the outcome of DMARC email processing cycles so /health can report whether
 * reports are actually being ingested, not just whether the HTTP server is up.
 *
 * Why this exists: on 2026-10-07 a transient DNS failure (getaddrinfo EAI_AGAIN) left
 * the IMAP client permanently unable to connect, while /health kept answering 200 with
 * a database-only check. The container therefore reported "healthy" for five days while
 * every scheduled run failed and 22 reports piled up in the mailbox.
 */

export interface ProcessingResultSummary {
  processed: number;
  forensic: number;
  errors: number;
  skipped: number;
}

export interface ProcessingStatusSnapshot {
  startedAt: string;
  lastCompletedAt: string | null;
  lastResult: ProcessingResultSummary | null;
  lastFailedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Null until the first cycle has looked; false means nobody has configured a mailbox yet. */
  mailboxConfigured: boolean | null;
  scheduledIntervalMs: number | null;
  nextScheduledAt: string | null;
}

export interface ProcessingHealth {
  healthy: boolean;
  reason: string | null;
}

/** The initial run happens within seconds of boot; allow a little slack before flagging. */
const STARTUP_GRACE_MS = 3 * 60 * 1000;

/** Two consecutive failures is ~10 minutes at the default 5 minute interval. */
const FAILURE_THRESHOLD = 2;

/** Flag when no cycle has completed for this many scheduled intervals. */
const MISSED_RUN_FACTOR = 3;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const state = {
  startedAt: new Date(),
  lastCompletedAt: null as Date | null,
  lastResult: null as ProcessingResultSummary | null,
  lastFailedAt: null as Date | null,
  lastError: null as string | null,
  consecutiveFailures: 0,
  mailboxConfigured: null as boolean | null,
  scheduledIntervalMs: null as number | null,
  nextScheduledAt: null as Date | null,
};

export function recordProcessingSuccess(result: ProcessingResultSummary): void {
  state.lastCompletedAt = new Date();
  state.lastResult = {
    processed: result.processed,
    forensic: result.forensic,
    errors: result.errors,
    skipped: result.skipped,
  };
  state.consecutiveFailures = 0;
  state.lastError = null;
}

export function recordProcessingFailure(error: unknown): void {
  state.lastFailedAt = new Date();
  state.lastError = error instanceof Error ? error.message : String(error);
  state.consecutiveFailures += 1;
}

export function recordScheduledRun(intervalMs: number, nextRunAt: Date): void {
  state.scheduledIntervalMs = intervalMs;
  state.nextScheduledAt = nextRunAt;
}

/**
 * Tracks whether a mailbox has been configured at all, so /health can distinguish "nothing to
 * do yet" from "something is broken" - conflating those is how a dead parser stays green.
 */
export function setMailboxConfigured(configured: boolean): void {
  state.mailboxConfigured = configured;
}

export function getProcessingStatus(): ProcessingStatusSnapshot {
  return {
    startedAt: state.startedAt.toISOString(),
    lastCompletedAt: state.lastCompletedAt ? state.lastCompletedAt.toISOString() : null,
    lastResult: state.lastResult,
    lastFailedAt: state.lastFailedAt ? state.lastFailedAt.toISOString() : null,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    mailboxConfigured: state.mailboxConfigured,
    scheduledIntervalMs: state.scheduledIntervalMs,
    nextScheduledAt: state.nextScheduledAt ? state.nextScheduledAt.toISOString() : null,
  };
}

export function evaluateProcessingHealth(now: Date = new Date()): ProcessingHealth {
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    return {
      healthy: false,
      reason: `${state.consecutiveFailures} consecutive processing failures (last: ${state.lastError ?? 'unknown error'})`,
    };
  }

  // Only judge staleness when a schedule is actually running, otherwise "no recent
  // run" is expected rather than a fault.
  if (state.scheduledIntervalMs !== null) {
    const intervalMs = state.scheduledIntervalMs || DEFAULT_INTERVAL_MS;
    const reference = state.lastCompletedAt;
    if (reference) {
      const ageMs = now.getTime() - reference.getTime();
      if (ageMs > intervalMs * MISSED_RUN_FACTOR) {
        return {
          healthy: false,
          reason: `no completed processing run for ${Math.round(ageMs / 1000)}s (expected every ${Math.round(intervalMs / 1000)}s)`,
        };
      }
    } else {
      const uptimeMs = now.getTime() - state.startedAt.getTime();
      if (uptimeMs > STARTUP_GRACE_MS) {
        return {
          healthy: false,
          reason: `no completed processing run since startup ${Math.round(uptimeMs / 1000)}s ago`,
        };
      }
    }
  }

  return { healthy: true, reason: null };
}
