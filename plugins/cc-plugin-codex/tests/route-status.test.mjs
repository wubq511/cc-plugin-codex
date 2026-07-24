import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_STATUSES,
  computeRouteStatus,
  isValidRouteStatus,
  describeRouteStatus,
} from "../scripts/lib/route-status.mjs";

// ─── Status Enum ─────────────────────────────────────────────────────────────

test("ROUTE_STATUSES contains the 5 defined statuses", () => {
  const statuses = Object.values(ROUTE_STATUSES);
  assert.equal(statuses.length, 5);
  assert.equal(ROUTE_STATUSES.RESOLVED, "resolved");
  assert.equal(ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED, "accepted_but_unverified");
  assert.equal(ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE, "model_drift_possible");
  assert.equal(ROUTE_STATUSES.REJECTED, "rejected");
  assert.equal(ROUTE_STATUSES.CANCELLED, "cancelled");
});

test("isValidRouteStatus accepts known statuses and rejects unknown ones", () => {
  for (const status of Object.values(ROUTE_STATUSES)) {
    assert.ok(isValidRouteStatus(status), `${status} should be valid`);
  }
  assert.ok(!isValidRouteStatus("unknown"));
  assert.ok(!isValidRouteStatus(""));
  assert.ok(!isValidRouteStatus(null));
});

test("describeRouteStatus returns human-readable descriptions", () => {
  for (const status of Object.values(ROUTE_STATUSES)) {
    const desc = describeRouteStatus(status);
    assert.ok(desc);
    assert.ok(desc.length > 10);
  }
  assert.match(describeRouteStatus("unknown"), /Unknown/i);
});

// ─── Computation: No Route Snapshot ──────────────────────────────────────────

test("computeRouteStatus returns null when no route snapshot exists (pre-v5 job)", () => {
  const status = computeRouteStatus({
    routeSnapshot: null,
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "model-a", scopes: ["main"] }],
    usageModelKeys: ["model-a"],
  });
  assert.equal(status, null);
});

// ─── Computation: Cancelled ──────────────────────────────────────────────────

test("computeRouteStatus returns null for cancelled jobs", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: "inherited" },
    jobOk: false,
    cancelled: true,
    executedModels: [],
    usageModelKeys: [],
  });
  assert.equal(status, null);
});

// ─── Computation: Rejected ───────────────────────────────────────────────────

test("computeRouteStatus returns rejected for failed (non-cancelled) jobs", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: "inherited" },
    jobOk: false,
    cancelled: false,
    executedModels: [],
    usageModelKeys: [],
  });
  assert.equal(status, ROUTE_STATUSES.REJECTED);
});

// ─── Computation: Accepted But Unverified ────────────────────────────────────

test("computeRouteStatus returns accepted_but_unverified when no transcript evidence", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: "inherited" },
    jobOk: true,
    cancelled: false,
    executedModels: [],
    usageModelKeys: ["some-usage-key"],
  });
  assert.equal(status, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
});

test("computeRouteStatus returns accepted_but_unverified when executedModels is missing", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: "alias" },
    jobOk: true,
    cancelled: false,
    executedModels: null,
    usageModelKeys: [],
  });
  assert.equal(status, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
});

// ─── Computation: Inherited ──────────────────────────────────────────────────

test("computeRouteStatus returns resolved for inherited with any execution model", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: "inherited" },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "any-model", scopes: ["main"] }],
    usageModelKeys: ["any-model"],
  });
  assert.equal(status, ROUTE_STATUSES.RESOLVED);
});

test("computeRouteStatus returns resolved for null selectorKind (legacy v5 migration)", () => {
  const status = computeRouteStatus({
    routeSnapshot: { selectorKind: null },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "any-model", scopes: ["main"] }],
    usageModelKeys: [],
  });
  assert.equal(status, ROUTE_STATUSES.RESOLVED);
});

// ─── Computation: Alias ──────────────────────────────────────────────────────

test("computeRouteStatus returns resolved for alias when claim matches execution model", () => {
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "alias",
      aliasClaim: { alias: "opus", nativeId: "anthropic-opus-4" },
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "anthropic-opus-4", scopes: ["main"] }],
    usageModelKeys: ["anthropic-opus-4"],
  });
  assert.equal(status, ROUTE_STATUSES.RESOLVED);
});

test("computeRouteStatus returns model_drift_possible for alias when claim does not match", () => {
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "alias",
      aliasClaim: { alias: "opus", nativeId: "anthropic-opus-4" },
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "anthropic-sonnet-4", scopes: ["main"] }],
    usageModelKeys: ["anthropic-sonnet-4"],
  });
  assert.equal(status, ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE);
});

test("computeRouteStatus returns accepted_but_unverified for alias with no claim", () => {
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "alias",
      aliasClaim: null,
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "some-model", scopes: ["main"] }],
    usageModelKeys: ["some-model"],
  });
  assert.equal(status, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
});

// ─── Computation: Native ─────────────────────────────────────────────────────

test("computeRouteStatus returns resolved for native when ID matches execution model", () => {
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "native",
      cliArg: "deepseek-v4-pro",
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "deepseek-v4-pro", scopes: ["main"] }],
    usageModelKeys: ["deepseek-v4-pro"],
  });
  assert.equal(status, ROUTE_STATUSES.RESOLVED);
});

test("computeRouteStatus returns model_drift_possible for native when ID does not match", () => {
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "native",
      cliArg: "deepseek-v4-pro",
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "glm-5.2", scopes: ["main"] }],
    usageModelKeys: ["glm-5.2"],
  });
  assert.equal(status, ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE);
});

// ─── Usage Key ≠ Execution Model ─────────────────────────────────────────────

test("usage model keys are never treated as execution models", () => {
  // Even if usage keys match the claim, without executedModels it's unverified
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "alias",
      aliasClaim: { alias: "opus", nativeId: "anthropic-opus-4" },
    },
    jobOk: true,
    cancelled: false,
    executedModels: [],
    usageModelKeys: ["anthropic-opus-4"], // matches claim but is a usage key, not execution model
  });
  assert.equal(status, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
});

test("execution models and usage keys are semantically separate in drift detection", () => {
  // Usage key matches claim but execution model differs → drift
  const status = computeRouteStatus({
    routeSnapshot: {
      selectorKind: "alias",
      aliasClaim: { alias: "opus", nativeId: "anthropic-opus-4" },
    },
    jobOk: true,
    cancelled: false,
    executedModels: [{ id: "anthropic-sonnet-4", scopes: ["main"] }],
    usageModelKeys: ["anthropic-opus-4"], // usage key matches claim, but execution model differs
  });
  assert.equal(status, ROUTE_STATUSES.MODEL_DRIFT_POSSIBLE);
});
