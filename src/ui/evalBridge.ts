/**
 * Bridge between the evaluator and the Ink UI.
 *
 * This module provides the connection between the evaluator's progress callbacks
 * and the React state management in the Ink UI.
 */

import type { Dispatch } from 'react';

import { assignProviderUiKeys, getProviderUiKey } from '../util/providerIdentity';
import { TokenUsageTracker } from '../util/tokenUsage';
import { TIMING } from './constants';

import type {
  EvalProgressInfo,
  EvaluateTable,
  PromptMetrics,
  RunEvalOptions,
} from '../types/index';
import type { EvalAction, LogEntry, SessionPhase, SharingStatus } from './contexts/EvalContext';
import type { ProviderDefinition, ProviderInput } from './machines/evalMachine';

// ============================================================================
// Batching Infrastructure
// ============================================================================

/**
 * A single progress item to be batched.
 * Contains all data needed to update state for one test completion.
 */
export interface BatchProgressItem {
  provider: string;
  providerTotal?: number;
  passed?: boolean;
  error?: boolean;
  outcome?: 'pass' | 'fail' | 'error';
  latencyMs: number;
  cost: number;
  completed: number;
  total: number;
}

/**
 * Creates a batching dispatcher that queues progress updates and flushes them
 * at a throttled rate. This dramatically reduces the number of state updates
 * and re-renders when running with high concurrency.
 *
 * Design:
 * - First item in a batch is dispatched immediately for responsiveness
 * - Subsequent items are queued and flushed after BATCH_INTERVAL_MS interval
 * - On flush, all queued items are sent as a single BATCH_PROGRESS event
 * - Timer is cleared on cleanup to prevent memory leaks
 */
function createBatchingDispatcher(dispatch: (action: EvalAction) => void) {
  const pendingItems: BatchProgressItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let isFirstInBatch = true;
  let disposed = false;

  function flushBatch() {
    if (disposed) {
      return;
    }
    if (pendingItems.length > 0) {
      dispatch({
        type: 'BATCH_PROGRESS',
        payload: { items: [...pendingItems] },
      });
      pendingItems.length = 0;
    }
    flushTimer = null;
    isFirstInBatch = true;
  }

  function queueProgress(item: BatchProgressItem) {
    if (disposed) {
      return;
    }

    // First item dispatched immediately for responsiveness
    if (isFirstInBatch) {
      isFirstInBatch = false;
      dispatch({
        type: 'PROGRESS',
        payload: {
          completed: item.completed,
          total: item.total,
          provider: item.provider,
          providerTotal: item.providerTotal,
          passed: item.passed,
          error: item.error ? 'Test error' : undefined,
          outcome: item.outcome,
          latencyMs: item.latencyMs,
          cost: item.cost,
        },
      });
      // Schedule flush for any subsequent items
      if (!flushTimer) {
        flushTimer = setTimeout(flushBatch, TIMING.BATCH_INTERVAL_MS);
      }
      return;
    }

    // Queue subsequent items
    pendingItems.push(item);

    // Ensure flush is scheduled
    if (!flushTimer) {
      flushTimer = setTimeout(flushBatch, TIMING.BATCH_INTERVAL_MS);
    }
  }

  function cleanup() {
    // Set disposed first to prevent new items being queued
    disposed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Flush any remaining items directly (bypass disposed check in flushBatch)
    if (pendingItems.length > 0) {
      dispatch({
        type: 'BATCH_PROGRESS',
        payload: { items: [...pendingItems] },
      });
      pendingItems.length = 0;
    }
  }

  return { queueProgress, flushBatch, cleanup };
}

// ============================================================================
// Delta Tracking
// ============================================================================

/**
 * State for tracking deltas between progress callbacks for a single prompt.
 * The key insight is that metrics are tracked per-PROMPT (not per-provider),
 * so we need to track deltas at the prompt level to compute correct pass/fail counts.
 */
interface PromptTrackingState {
  lastMetrics: PromptMetrics | null;
}

/**
 * Creates a progress callback that uses batching for high-concurrency performance.
 * Instead of dispatching every progress update immediately, updates are queued
 * and flushed at a throttled rate (50ms), dramatically reducing state updates
 * and re-renders when running with -j 100+.
 *
 * @param dispatch - The dispatch function from EvalContext (used for grading tokens)
 * @param queueProgress - The batching queue function
 * @returns A progress callback function compatible with the evaluator
 */
function createProgressCallbackWithBatching(
  dispatch: Dispatch<EvalAction>,
  queueProgress: (item: BatchProgressItem) => void,
): (
  completed: number,
  total: number,
  index: number,
  evalStep?: RunEvalOptions,
  metrics?: PromptMetrics,
  progress?: EvalProgressInfo,
) => void {
  // Track state between callbacks for delta calculations - PER PROMPT
  const promptStateByKey = new Map<string, PromptTrackingState>();

  return (
    completed: number,
    total: number,
    _index: number,
    evalStep?: RunEvalOptions,
    metrics?: PromptMetrics,
    progress?: EvalProgressInfo,
  ) => {
    if (!evalStep) {
      // For non-test progress (e.g., comparison steps), dispatch directly
      dispatch({
        type: 'PROGRESS',
        payload: { completed, total, prompt: progress?.prompt },
      });
      return;
    }

    const providerId = getProviderUiKey(evalStep.provider);
    const promptIdx = evalStep.promptIdx;
    const trackingKey = `${providerId}:${promptIdx}`;

    // Calculate deltas from last callback FOR THIS PROMPT
    let outcome = progress?.outcome;
    let latencyMs = 0;
    let cost = 0;

    if (metrics) {
      // Get or create per-prompt tracking state
      let promptState = promptStateByKey.get(trackingKey);
      if (!promptState) {
        promptState = { lastMetrics: null };
        promptStateByKey.set(trackingKey, promptState);
      }

      const lastMetrics = promptState.lastMetrics;

      // Calculate deltas
      const prevPass = lastMetrics?.testPassCount ?? 0;
      const prevFail = lastMetrics?.testFailCount ?? 0;
      const prevError = lastMetrics?.testErrorCount ?? 0;
      const prevLatency = lastMetrics?.totalLatencyMs ?? 0;
      const prevCost = lastMetrics?.cost ?? 0;

      const deltaPass = metrics.testPassCount - prevPass;
      const deltaFail = metrics.testFailCount - prevFail;
      const deltaError = metrics.testErrorCount - prevError;
      const deltaLatency = metrics.totalLatencyMs - prevLatency;
      const deltaCost = metrics.cost - prevCost;

      if (!outcome) {
        // Determine test result from metric deltas when the evaluator did not provide it explicitly.
        if (deltaPass > 0) {
          outcome = 'pass';
        } else if (deltaFail > 0) {
          outcome = 'fail';
        } else if (deltaError > 0) {
          outcome = 'error';
        } else {
          // Fallback logic for edge cases
          const prevTotal = prevPass + prevFail + prevError;
          const currentTotal =
            metrics.testPassCount + metrics.testFailCount + metrics.testErrorCount;
          if (currentTotal > prevTotal) {
            if (deltaPass >= deltaFail && deltaPass >= deltaError) {
              outcome = 'pass';
            } else if (deltaFail >= deltaError) {
              outcome = 'fail';
            } else {
              outcome = 'error';
            }
          }
        }
      }

      if (!outcome) {
        const prevTotal = prevPass + prevFail + prevError;
        const currentTotal = metrics.testPassCount + metrics.testFailCount + metrics.testErrorCount;
        if (currentTotal > prevTotal && deltaError > 0) {
          outcome = 'error';
        }
      }

      latencyMs = Math.max(0, deltaLatency);
      cost = Math.max(0, deltaCost);

      // Update tracking state
      promptState.lastMetrics = { ...metrics };
    }

    // Grading tokens are still dispatched directly (low frequency, important accuracy)
    if (metrics?.tokenUsage?.assertions) {
      const assertions = metrics.tokenUsage.assertions;
      if (assertions.total != null && assertions.total > 0) {
        dispatch({
          type: 'SET_GRADING_TOKENS',
          payload: {
            providerId,
            tokens: {
              total: assertions.total ?? 0,
              prompt: assertions.prompt ?? 0,
              completion: assertions.completion ?? 0,
              cached: assertions.cached ?? 0,
              reasoning: assertions.completionDetails?.reasoning ?? 0,
            },
          },
        });
      }
    }

    // Queue progress update for batching (instead of direct dispatch)
    const passed = outcome === 'pass' ? true : outcome ? false : undefined;
    const error = outcome === 'error' ? true : outcome ? false : undefined;
    queueProgress({
      provider: providerId,
      providerTotal: progress?.providerTotal,
      passed,
      error,
      outcome,
      latencyMs,
      cost,
      completed,
      total,
    });
  };
}

/**
 * Interface for the eval UI controller.
 */
export interface EvalUIController {
  /** Initialize the UI with evaluation parameters */
  init: (totalTests: number, providers: ProviderInput[], concurrency?: number) => void;
  /** Mark evaluation as started */
  start: () => void;
  /** Transition into the grading/comparison phase */
  startGrading: (completed: number, total: number) => void;
  /** Update progress */
  progress: (
    completed: number,
    total: number,
    index: number,
    evalStep?: RunEvalOptions,
    metrics?: PromptMetrics,
    progress?: EvalProgressInfo,
  ) => void;
  /** Add an error */
  addError: (
    provider: string,
    prompt: string,
    message: string,
    vars?: Record<string, unknown>,
  ) => void;
  /** Add a log entry (for verbose mode) */
  addLog: (entry: LogEntry) => void;
  /** Mark evaluation as complete */
  complete: (summary: { passed: number; failed: number; errors: number }) => void;
  /** Mark evaluation as errored */
  error: (message: string) => void;
  /**
   * @deprecated Phase transitions are managed by the state machine via init/start/complete/error.
   * This method is a no-op and will be removed in a future version.
   */
  setPhase: (phase: 'loading' | 'evaluating' | 'grading' | 'completed' | 'error') => void;
  /** Set the share URL */
  setShareUrl: (url: string) => void;
  /** Set the sharing status (for background sharing progress) */
  setSharingStatus: (status: SharingStatus, url?: string) => void;
  /** Set the session phase (transition between eval and results views) */
  setSessionPhase: (phase: SessionPhase) => void;
  /** Transition to results view with table data */
  showResults: (tableData: EvaluateTable) => void;
  /** Cleanup batching timers (called automatically on complete) */
  cleanup: () => void;
}

/**
 * Creates a UI controller that wraps dispatch for easier use from non-React code.
 * Uses batching for high-concurrency performance.
 *
 * @param dispatch - The dispatch function from EvalContext
 * @returns An EvalUIController object
 */
export function createEvalUIController(dispatch: Dispatch<EvalAction>): EvalUIController {
  // Create batching dispatcher for high-concurrency performance
  const batcher = createBatchingDispatcher(dispatch);

  // Create the progress callback with integrated batching
  const progressCallback = createProgressCallbackWithBatching(dispatch, batcher.queueProgress);

  return {
    init: (totalTests: number, providers: ProviderInput[], concurrency?: number) => {
      dispatch({ type: 'INIT', payload: { totalTests, providers, concurrency } });
    },

    start: () => {
      dispatch({ type: 'START' });
    },

    startGrading: (completed: number, total: number) => {
      dispatch({ type: 'START_GRADING', payload: { completed, total } });
    },

    progress: progressCallback,

    addError: (
      provider: string,
      prompt: string,
      message: string,
      vars?: Record<string, unknown>,
    ) => {
      dispatch({ type: 'ADD_ERROR', payload: { provider, prompt, message, vars } });
    },

    addLog: (entry: LogEntry) => {
      dispatch({ type: 'ADD_LOG', payload: entry });
    },

    complete: (summary: { passed: number; failed: number; errors: number }) => {
      // Flush any pending batched updates before completing
      batcher.cleanup();
      dispatch({ type: 'COMPLETE', payload: summary });
    },

    error: (message: string) => {
      // Cleanup on error too
      batcher.cleanup();
      dispatch({ type: 'ERROR', payload: { message } });
    },

    setPhase: (_phase: 'loading' | 'evaluating' | 'grading' | 'completed' | 'error') => {
      // No-op: Phase transitions are managed by the state machine via init/start/complete/error.
      // This method exists only for interface compatibility and will be removed.
    },

    setShareUrl: (url: string) => {
      dispatch({ type: 'SET_SHARE_URL', payload: url });
    },

    setSharingStatus: (status: SharingStatus, url?: string) => {
      dispatch({ type: 'SET_SHARING_STATUS', payload: { status, url } });
    },

    setSessionPhase: (phase: SessionPhase) => {
      dispatch({ type: 'SET_SESSION_PHASE', payload: phase });
    },

    showResults: (tableData: EvaluateTable) => {
      // SET_TABLE_DATA maps to SHOW_RESULTS which transitions to 'results' state AND sets table data
      dispatch({ type: 'SET_TABLE_DATA', payload: tableData });
    },

    cleanup: () => {
      batcher.cleanup();
    },
  };
}

/**
 * Extract provider IDs from evaluate options and test suite.
 * Also registers the label map on TokenUsageTracker so the UI hook
 * can resolve labeled providers to machine keys.
 */
export function extractProviderDefinitions(
  providers: Array<{ id: () => string; label?: string }>,
): ProviderDefinition[] {
  const identities = assignProviderUiKeys(providers);
  const labelCounts = new Map<string, number>();
  const rawIdCountsByLabel = new Map<string, Map<string, number>>();
  const rawIdCounts = new Map<string, number>();
  const ordinalByLabel = new Map<string, number>();

  for (const identity of identities) {
    labelCounts.set(identity.label, (labelCounts.get(identity.label) ?? 0) + 1);
    const countsForLabel = rawIdCountsByLabel.get(identity.label) ?? new Map<string, number>();
    countsForLabel.set(identity.rawId, (countsForLabel.get(identity.rawId) ?? 0) + 1);
    rawIdCountsByLabel.set(identity.label, countsForLabel);
    rawIdCounts.set(identity.rawId, (rawIdCounts.get(identity.rawId) ?? 0) + 1);
  }

  // Build and register label map for token metrics resolution.
  // Exact per-run keys always resolve to themselves; raw provider IDs only resolve
  // when they are unique across the current run.
  const labelMap = new Map<string, string>();
  for (const identity of identities) {
    labelMap.set(identity.key, identity.key);
    if ((rawIdCounts.get(identity.rawId) ?? 0) === 1) {
      labelMap.set(identity.rawId, identity.key);
    }
  }

  // Register label map so useTokenMetrics can resolve labeled providers
  TokenUsageTracker.getInstance().setLabelMap(labelMap);

  return identities.map((identity) => ({
    id: identity.key,
    label: (() => {
      if ((labelCounts.get(identity.label) ?? 0) <= 1) {
        return identity.label;
      }

      const rawIdCounts = rawIdCountsByLabel.get(identity.label);
      if ((rawIdCounts?.get(identity.rawId) ?? 0) === 1 && identity.rawId !== identity.label) {
        return `${identity.label} (${identity.rawId})`;
      }

      const ordinal = (ordinalByLabel.get(identity.label) ?? 0) + 1;
      ordinalByLabel.set(identity.label, ordinal);
      return `${identity.label} (${ordinal})`;
    })(),
  }));
}

/**
 * Extract provider IDs from evaluate options and test suite.
 * Also registers the label map on TokenUsageTracker so the UI hook
 * can resolve labeled providers to machine keys.
 */
export function extractProviderIds(
  providers: Array<{ id: () => string; label?: string }>,
): string[] {
  return extractProviderDefinitions(providers).map((provider) => provider.id);
}
