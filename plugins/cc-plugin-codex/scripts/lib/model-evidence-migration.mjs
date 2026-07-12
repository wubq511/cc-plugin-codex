/**
 * Model evidence migration — v3 → v4 schema conversion.
 *
 * observedModel (from modelUsage first key) → usageModelKeys only.
 * NEVER migrate observedModel to executedModels.
 */

import { normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

/**
 * Migrate a v3 job's model fields to v4 modelEvidence structure.
 * observedModel (from modelUsage first key) → usageModelKeys only.
 * NEVER migrate observedModel to executedModels.
 */
export function migrateV3ModelFields(job) {
  if (job.version >= 4 && job.modelEvidence) return job;

  const migrated = { ...job };

  // Determine requestMode
  migrated.requestMode = migrated.requestedModel ? "explicit" : "inherited";

  // Build modelEvidence from v3 observedModel
  const warnings = [];
  const usageKeys = [];

  if (migrated.observedModel && typeof migrated.observedModel === "string") {
    const sanitized = normalizeModelIdForStorage(migrated.observedModel);
    if (sanitized) {
      usageKeys.push(sanitized);
    }
    warnings.push("legacy-observed-model-reclassified-as-usage-key");
  }

  migrated.modelEvidence = {
    status: "unavailable", // No transcript evidence available for v3 jobs
    executedModels: [],     // NEVER populate from observedModel
    usageModelKeys: usageKeys,
    usageSource: "claude-result-modelUsage",
    warnings,
  };

  migrated.version = 4;

  // Remove observedModel from the migrated record (stop writing it)
  delete migrated.observedModel;

  return migrated;
}
