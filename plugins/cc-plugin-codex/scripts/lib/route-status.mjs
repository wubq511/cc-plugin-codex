/**
 * Route status computation — honest post-execution route verification.
 *
 * The final route status is one of:
 *   resolved                   — a requested native ID and runtime evidence agree
 *   accepted_but_unverified    — job succeeded but no transcript evidence available
 *   model_drift_possible       — route claim and execution evidence disagree
 *   rejected                   — CLI/Provider rejection or failure
 *   cancelled                  — documented non-terminal exception: the job was
 *                                cancelled before execution evidence could be
 *                                collected. This is NOT a computed route status
 *                                from execution evidence; it is a documented
 *                                terminal-state marker that prevents null from
 *                                being persisted as a final route status.
 *
 * A configuration claim (route snapshot) is NEVER treated as execution proof.
 * A usage key is NEVER treated as an execution model.
 * Cancellation never persists null — it persists "cancelled".
 */

import { normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

/**
 * Known route status values.
 */
export const ROUTE_STATUSES = Object.freeze({
  RESOLVED: "resolved",
  ACCEPTED_BUT_UNVERIFIED: "accepted_but_unverified",
  MODEL_DRIFT_POSSIBLE: "model_drift_possible",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

const VALID_STATUSES = new Set(Object.values(ROUTE_STATUSES));

/**
 * Compute the route status from the route snapshot and execution evidence.
 *
 * @param {object} options
 * @param {object|null} options.routeSnapshot - The route snapshot from job start
 * @param {boolean} options.jobOk - Whether the job succeeded
 * @param {boolean} options.cancelled - Whether the job was cancelled
 * @param {Array} options.executedModels - Transcript execution models [{ id, scopes }]
 * @param {Array} options.usageModelKeys - Usage model keys from final JSON
 * @returns {string|null} Route status, or null if no route snapshot exists
 */
export function computeRouteStatus({ routeSnapshot, jobOk, cancelled, executedModels = [], usageModelKeys = [] }) {
  // Cancellation is a documented terminal marker even when a legacy record
  // lacks a route snapshot.
  if (cancelled) return ROUTE_STATUSES.CANCELLED;

  // No route snapshot — can't compute a status (pre-v5 job or bare migration)
  if (!routeSnapshot) return null;

  // Failed jobs are rejected
  if (!jobOk) return ROUTE_STATUSES.REJECTED;

  // No execution evidence — accepted but unverified
  const hasExecutedModels = Array.isArray(executedModels) && executedModels.length > 0;
  if (!hasExecutedModels) {
    return ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED;
  }

  const selectorKind = routeSnapshot.selectorKind;

  // Inherited: any execution model is acceptable (we didn't claim a specific model)
  if (selectorKind === "inherited" || !selectorKind) {
    return ROUTE_STATUSES.RESOLVED;
  }

  // Get normalized executed model IDs
  const execIds = executedModels
    .map((m) => normalizeModelIdForStorage(m?.id))
    .filter(Boolean);

  // Alias: the plugin deliberately has no alias-to-native mapping. It can prove
  // that the alias was accepted by native Claude, but cannot infer which
  // provider model the CLI selected. Transcript evidence is still shown to the
  // caller without upgrading this status to a native-model confirmation.
  if (selectorKind === "alias") {
    return ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED;
  }

  // Native: compare the passed native ID with executed models
  if (selectorKind === "native") {
    const requestedId = normalizeModelIdForStorage(routeSnapshot.cliArg);
    if (requestedId && execIds.includes(requestedId)) {
      return ROUTE_STATUSES.RESOLVED;
    }
    // Native ID was passed but a different model executed
    return ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE;
  }

  // Unknown selector kind — conservative
  return ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED;
}

/**
 * Validate that a route status value is from the fixed enum.
 */
export function isValidRouteStatus(status) {
  return VALID_STATUSES.has(status);
}

/**
 * Get a human-readable description of a route status.
 */
export function describeRouteStatus(status) {
  const descriptions = {
    [ROUTE_STATUSES.RESOLVED]: "Route claim confirmed by runtime execution evidence.",
    [ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED]: "Job succeeded, but the requested route could not be confirmed as a specific native model.",
    [ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE]: "Route claim and execution evidence disagree — the Provider may have used a different model.",
    [ROUTE_STATUSES.REJECTED]: "Job failed — the route was not accepted by the CLI or Provider.",
    [ROUTE_STATUSES.CANCELLED]: "Job was cancelled before execution evidence could be collected. This is a documented non-terminal exception, not a computed route status.",
  };
  return descriptions[status] || "Unknown route status.";
}
