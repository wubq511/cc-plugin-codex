import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanner,
  computePressure,
  classifyEvidenceState,
  PlannerError,
  PRESSURE_THRESHOLD,
  PLAN_TTL_MS,
  PLAN_MAX_ENTRIES,
  ACTIONS,
} from "../scripts/lib/continuation-planner.mjs";
import {
  extractContextWindow,
  extractUsageTokens,
} from "../scripts/lib/model-evidence-shared.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usage(input, cacheCreation, cacheRead, output) {
  return { input, cacheCreation, cacheRead, output };
}

function baseInput(overrides = {}) {
  return {
    cwd: "/workspace",
    parentJob: "cc-prev1",
    parentSession: "sess-prev1",
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
    ...overrides,
  };
}

function recordFullEvidence(planner, overrides = {}) {
  planner.recordEvidence({
    jobId: "cc-prev1",
    sessionId: "sess-prev1",
    cwd: "/workspace",
    model: null,
    write: true,
    usage: usage(1000, 200, 300, 500),
    contextWindow: 200000,
    ...overrides,
  });
}

const compactBinding = {
  cwd: "/workspace",
  parentSession: "sess-prev1",
};

// ─── Pure helpers: pressure ──────────────────────────────────────────────────

test("computePressure returns the (input+cacheCreation+cacheRead+output)/contextWindow ratio", () => {
  // 1000+200+300+500 = 2000; 2000/200000 = 0.01
  assert.equal(computePressure(usage(1000, 200, 300, 500), 200000), 0.01);
});

test("computePressure returns null when contextWindow is missing or invalid", () => {
  assert.equal(computePressure(usage(1, 1, 1, 1), null), null);
  assert.equal(computePressure(usage(1, 1, 1, 1), 0), null);
  assert.equal(computePressure(usage(1, 1, 1, 1), -1), null);
  assert.equal(computePressure(null, 200000), null);
});

test("computePressure returns null when any token field is non-finite", () => {
  assert.equal(computePressure({ input: 1, cacheCreation: 1, cacheRead: 1, output: "x" }, 200000), null);
  assert.equal(computePressure({ input: NaN, cacheCreation: 1, cacheRead: 1, output: 1 }, 200000), null);
});

test("computePressure never treats cumulative usage as the live context window", () => {
  // The ratio is a raw sum over the user-declared denominator; the caller
  // interprets it, computePressure does not clamp or equate it to a window.
  const high = computePressure(usage(150000, 50000, 100000, 20000), 200000);
  assert.ok(high > PRESSURE_THRESHOLD);
});

// ─── Pure helpers: evidence state ────────────────────────────────────────────

test("classifyEvidenceState returns unavailable when no evidence record exists", () => {
  assert.equal(classifyEvidenceState(null, null, false), "unavailable");
});

test("classifyEvidenceState returns complete only when all four token fields and contextWindow are finite", () => {
  assert.equal(classifyEvidenceState(usage(1, 2, 3, 4), 200000, true), "complete");
});

test("classifyEvidenceState returns partial when contextWindow is missing", () => {
  assert.equal(classifyEvidenceState(usage(1, 2, 3, 4), null, true), "partial");
});

test("classifyEvidenceState returns partial when a token field is missing", () => {
  assert.equal(classifyEvidenceState({ input: 1, cacheCreation: 2, cacheRead: null, output: 4 }, 200000, true), "partial");
});

// ─── Pure helpers: extractUsageTokens ────────────────────────────────────────

test("extractUsageTokens reads the last usage iteration, not the aggregate", () => {
  const parsed = {
    num_turns: 2,
    usage: {
      input_tokens: 999,
      cache_creation_input_tokens: 999,
      cache_read_input_tokens: 999,
      output_tokens: 999,
      iterations: [
        { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
        { input_tokens: 11, cache_creation_input_tokens: 21, cache_read_input_tokens: 31, output_tokens: 41 },
      ],
    },
  };
  assert.deepEqual(extractUsageTokens(parsed), usage(11, 21, 31, 41));
});

test("extractUsageTokens accepts aggregate usage only for an explicit single-turn result", () => {
  const parsed = {
    num_turns: 1,
    usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
  };
  assert.deepEqual(extractUsageTokens(parsed), usage(10, 20, 30, 40));
});

test("extractUsageTokens rejects cumulative multi-turn usage and modelUsage totals", () => {
  const parsed = {
    num_turns: 3,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {
      "model-a": { inputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 3, outputTokens: 2 },
      "model-b": { inputTokens: 7, cacheCreationInputTokens: 1, cacheReadInputTokens: 0, outputTokens: 4 },
    },
  };
  assert.equal(extractUsageTokens(parsed), null);
});

test("extractUsageTokens marks a last-iteration field null when omitted", () => {
  const parsed = {
    usage: { iterations: [{ input_tokens: 10, output_tokens: 2 }] },
  };
  const result = extractUsageTokens(parsed);
  assert.equal(result.input, 10);
  assert.equal(result.output, 2);
  assert.equal(result.cacheCreation, null);
  assert.equal(result.cacheRead, null);
});

test("extractUsageTokens returns null when no usage data is present", () => {
  assert.equal(extractUsageTokens({ result: "ok" }), null);
  assert.equal(extractUsageTokens({ modelUsage: { "model-a": {} } }), null);
  assert.equal(extractUsageTokens(null), null);
});

test("extractContextWindow accepts one provider-reported window", () => {
  assert.equal(extractContextWindow({
    modelUsage: {
      "model-a": { contextWindow: 200000 },
    },
  }), 200000);
});

test("extractContextWindow accepts multiple models only when their windows agree", () => {
  assert.equal(extractContextWindow({
    modelUsage: {
      "model-a": { contextWindow: 200000 },
      "model-b": { contextWindow: 200000 },
    },
  }), 200000);
  assert.equal(extractContextWindow({
    modelUsage: {
      "model-a": { contextWindow: 200000 },
      "model-b": { contextWindow: 1000000 },
    },
  }), null);
});

// ─── Decision matrix ─────────────────────────────────────────────────────────

test("explicit fresh intent always yields fresh_handoff", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  const r = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("explicit-fresh"));
  assert.equal(r.fallbackAction, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.handoffTemplate);
});

test("explicit same_session never yields fresh, and without high pressure resumes", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(100, 0, 0, 10), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session" }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(r.reasonCodes.includes("explicit-same-session"));
  assert.equal(r.fallbackAction, ACTIONS.RESUME);
});

test("explicit same_session with reliable high pressure + warm cache + allowCompact yields compact_resume", () => {
  const planner = createPlanner();
  // pressure = (150000+50000+100000+20000)/200000 = 1.6 > 0.75, cache_read>0
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  assert.equal(r.action, ACTIONS.COMPACT_RESUME);
  assert.ok(r.reasonCodes.includes("warm-cache"));
  assert.ok(r.compactFocus);
});

test("explicit same_session with high pressure but allowCompact=false yields resume", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: false }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(r.reasonCodes.includes("compact-not-allowed"));
});

test("auto: correctionCount>=2 yields fresh_handoff", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  const r = planner.planContinuation(baseInput({ correctionCount: 2 }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("repeated-corrections"));
});

test("auto: next_step/unrelated/unknown relationship yields fresh_handoff", () => {
  for (const rel of ["next_step", "unrelated", "unknown"]) {
    const planner = createPlanner();
    recordFullEvidence(planner);
    const r = planner.planContinuation(baseInput({ relationship: rel }));
    assert.equal(r.action, ACTIONS.FRESH_HANDOFF, `${rel} should be fresh`);
    assert.ok(r.reasonCodes.includes(`relationship-${rel}`));
  }
});

test("auto: reconstructable context yields fresh_handoff", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  const r = planner.planContinuation(baseInput({ contextValue: "reconstructable" }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("context-reconstructable"));
});

test("auto: workspace/model/cli/tool drift yields fresh_handoff", () => {
  for (const drift of [
    { workspace: true },
    { cli: true },
    { tool: true },
  ]) {
    const planner = createPlanner();
    recordFullEvidence(planner, { model: "opus" });
    const r = planner.planContinuation(baseInput({ drift, model: "opus" }));
    assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
    assert.ok(r.reasonCodes.includes("drift-detected"));
  }
});

test("auto: model drift (next model differs from evidence model) yields fresh_handoff", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { model: "opus" });
  const r = planner.planContinuation(baseInput({ model: "sonnet" }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("drift-detected"));
});

test("auto: explicit to inherited model mode is drift", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { model: "opus" });
  const r = planner.planContinuation(baseInput({ model: null }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("drift-detected"));
});

test("auto: write/tool profile drift is derived from evidence", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { write: true });
  const r = planner.planContinuation(baseInput({ write: false }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("drift-detected"));
});

test("auto: same_attempt, first correction, useful context, no drift yields resume", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(1000, 200, 300, 500), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ relationship: "same_attempt", correctionCount: 1, contextValue: "useful" }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(r.reasonCodes.includes("relationship-same_attempt"));
});

test("auto: reliable pressure>=75% with cache_read>0 yields compact_resume", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ relationship: "same_goal", contextValue: "essential", allowCompact: true }));
  assert.equal(r.action, ACTIONS.COMPACT_RESUME);
  assert.ok(r.reasonCodes.includes("high-pressure"));
});

test("auto: high-pressure cold cache with essential context yields resume", () => {
  const planner = createPlanner();
  // cache_read = 0 → cold cache; pressure high
  recordFullEvidence(planner, { usage: usage(150000, 50000, 0, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ relationship: "same_attempt", contextValue: "essential", allowCompact: true }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(r.reasonCodes.includes("high-pressure-cold-cache"));
  assert.ok(r.reasonCodes.includes("context-essential"));
});

test("auto: high-pressure cold cache with non-essential context yields fresh", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 0, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ relationship: "same_attempt", contextValue: "useful", allowCompact: true }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("context-not-essential"));
});

test("auto: pressure below threshold yields resume, not compact", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(1000, 200, 300, 500), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ relationship: "same_attempt", contextValue: "essential", allowCompact: true }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(r.reasonCodes.includes("pressure-below-threshold"));
});

// ─── Fail-closed: incomplete evidence never guesses Compact ──────────────────

test("incomplete evidence (partial) never yields compact_resume even with allowCompact", () => {
  const planner = createPlanner();
  // High pressure but contextWindow missing → partial evidence.
  planner.recordEvidence({
    jobId: "cc-prev1",
    sessionId: "sess-prev1",
    cwd: "/workspace",
    usage: usage(150000, 50000, 100000, 20000),
    contextWindow: null,
    model: null,
    write: true,
  });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  assert.notEqual(r.action, ACTIONS.COMPACT_RESUME);
  assert.equal(r.evidenceState, "partial");
});

test("missing token fields mark evidence partial and block compact", () => {
  const planner = createPlanner();
  planner.recordEvidence({
    jobId: "cc-prev1",
    sessionId: "sess-prev1",
    cwd: "/workspace",
    usage: { input: 150000, cacheCreation: null, cacheRead: 100000, output: 20000 },
    contextWindow: 200000,
    model: null,
    write: true,
  });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  assert.notEqual(r.action, ACTIONS.COMPACT_RESUME);
  assert.equal(r.evidenceState, "partial");
});

// ─── Restart loses evidence ──────────────────────────────────────────────────

test("a fresh planner instance has no evidence and defaults to fresh_handoff", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ parentJob: "cc-missing", parentSession: "sess-missing" }));
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.equal(r.evidenceState, "unavailable");
  assert.ok(r.reasonCodes.includes("no-evidence-restart-default"));
});

test("explicit same_session without a resolvable parent fails closed", () => {
  const planner = createPlanner();
  assert.throws(
    () => planner.planContinuation(baseInput({
      userIntent: "same_session",
      parentJob: null,
      parentSession: null,
    })),
    (err) => err instanceof PlannerError && err.code === "parent-session-required",
  );
});

// ─── Plan TTL and capacity ───────────────────────────────────────────────────

test("expired plans fail closed on consumption", () => {
  let currentTime = 1_000;
  const planner = createPlanner({ now: () => currentTime });
  const r = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  currentTime += PLAN_TTL_MS + 1;
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true }),
    (err) => err instanceof PlannerError && err.code === "plan-expired",
  );
});

test("parentJob and parentSession cannot select different evidence", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  planner.recordEvidence({
    jobId: "cc-prev2",
    sessionId: "sess-prev2",
    cwd: "/workspace",
    model: null,
    write: true,
    usage: usage(10, 0, 0, 1),
    contextWindow: 200000,
  });
  assert.throws(
    () => planner.planContinuation(baseInput({ parentSession: "sess-prev2" })),
    (err) => err instanceof PlannerError && err.code === "parent-mismatch",
  );
});

test("parent evidence cannot cross workspace boundaries", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  assert.throws(
    () => planner.planContinuation(baseInput({ cwd: "/other-workspace" })),
    (err) => err instanceof PlannerError && err.code === "evidence-cwd-mismatch",
  );
});

test("plan TTL constant is 15 minutes", () => {
  assert.equal(PLAN_TTL_MS, 15 * 60 * 1000);
});

test("plan capacity cap evicts oldest plans", () => {
  const planner = createPlanner();
  for (let i = 0; i < PLAN_MAX_ENTRIES + 10; i++) {
    planner.planContinuation(baseInput({ userIntent: "fresh", parentJob: `cc-${i}`, parentSession: `sess-${i}` }));
  }
  assert.equal(planner._planCount(), PLAN_MAX_ENTRIES);
});

test("pressure threshold is the named provisional constant 0.75", () => {
  assert.equal(PRESSURE_THRESHOLD, 0.75);
});

// ─── Plan consumption: wrong cwd/session/model/write ─────────────────────────

test("consumeDelegatePlan rejects cwd mismatch", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/other", model: null, write: true }),
    (err) => err instanceof PlannerError && err.code === "cwd-mismatch",
  );
});

test("consumeDelegatePlan rejects model mismatch", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh", model: "opus" }));
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: "sonnet", write: true }),
    (err) => err instanceof PlannerError && err.code === "model-mismatch",
  );
});

test("consumeDelegatePlan rejects write mismatch", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh", write: true }));
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: false }),
    (err) => err instanceof PlannerError && err.code === "write-mismatch",
  );
});

test("fresh plan forbids resume flags", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resume: true }),
    (err) => err instanceof PlannerError && err.code === "fresh-forbids-resume",
  );
});

test("resume plan requires the exact parent session", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  const r = planner.planContinuation(baseInput({ userIntent: "same_session" }));
  assert.equal(r.action, ACTIONS.RESUME);
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-other" }),
    (err) => err instanceof PlannerError && err.code === "resume-session-mismatch",
  );
  // Exact match succeeds.
  const out = planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" });
  assert.equal(out.action, ACTIONS.RESUME);
  assert.equal(out.parentSession, "sess-prev1");
});

// ─── Replay prevention: single consumption ───────────────────────────────────

test("fresh/resume plan can only be consumed once", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true });
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true }),
    (err) => err instanceof PlannerError && err.code === "plan-already-consumed",
  );
});

// ─── Compact lifecycle: issued → compacted → consumed ────────────────────────

test("compact_resume lifecycle: issued → compacted (with boundary) → consumed, each once", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  assert.equal(r.action, ACTIONS.COMPACT_RESUME);

  // Delegate cannot consume before compact completes.
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" }),
    (err) => err instanceof PlannerError && err.code === "compact-not-completed",
  );

  // Issue compact.
  const started = planner.startCompact(r.planId, compactBinding);
  assert.equal(started.parentSession, "sess-prev1");

  // Double-issue is rejected.
  assert.throws(
    () => planner.startCompact(r.planId, compactBinding),
    (err) => err instanceof PlannerError && err.code === "compact-already-issued",
  );

  // Complete compact with a new boundary.
  const completed = planner.completeCompact(r.planId, { ok: true, hasNewBoundary: true });
  assert.equal(completed.compacted, true);
  assert.equal(completed.hadBoundary, true);

  // Double-complete is rejected.
  assert.throws(
    () => planner.completeCompact(r.planId, { ok: true, hasNewBoundary: true }),
    (err) => err instanceof PlannerError && err.code === "compact-already-compacted",
  );

  // Consume the resume after compact.
  const consumed = planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" });
  assert.equal(consumed.action, ACTIONS.COMPACT_RESUME);
  assert.equal(consumed.compactHadBoundary, true);

  // Replay rejected.
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" }),
    (err) => err instanceof PlannerError && err.code === "plan-already-consumed",
  );
});

test("compact with no new boundary falls back to resume on the original session", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  planner.startCompact(r.planId, compactBinding);
  const completed = planner.completeCompact(r.planId, { ok: true, hasNewBoundary: false });
  assert.equal(completed.fallbackToResume, true);
  assert.equal(completed.action, ACTIONS.RESUME);

  // The plan now acts as a resume and can be consumed once.
  const consumed = planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" });
  assert.equal(consumed.action, ACTIONS.RESUME);
});

test("compact failure invalidates the plan and forces re-planning", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  planner.startCompact(r.planId, compactBinding);
  const completed = planner.completeCompact(r.planId, { ok: false });
  assert.equal(completed.failed, true);

  // Delegate cannot consume a failed-compact plan.
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" }),
    (err) => err instanceof PlannerError && err.code === "compact-failed-replan",
  );

  // Re-issuing compact on a failed plan is rejected.
  assert.throws(
    () => planner.startCompact(r.planId, compactBinding),
    (err) => err instanceof PlannerError && err.code === "compact-failed-replan",
  );
});

test("compact lifecycle rejects out-of-order transitions", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));

  // completeCompact before startCompact.
  assert.throws(
    () => planner.completeCompact(r.planId, { ok: true, hasNewBoundary: true }),
    (err) => err instanceof PlannerError && err.code === "compact-not-issued",
  );

  // startCompact on a non-compact plan.
  const freshPlan = planner.planContinuation(baseInput({ userIntent: "fresh" }));
  assert.throws(
    () => planner.startCompact(freshPlan.planId, compactBinding),
    (err) => err instanceof PlannerError && err.code === "plan-not-compact-resume",
  );
});

test("compact lifecycle enforces the bound workspace and parent session", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, {
    usage: usage(150000, 50000, 100000, 20000),
    contextWindow: 200000,
  });
  const r = planner.planContinuation(baseInput({
    userIntent: "same_session",
    allowCompact: true,
  }));
  assert.throws(
    () => planner.startCompact(r.planId, {
      cwd: "/other-workspace",
      parentSession: "sess-prev1",
    }),
    (err) => err instanceof PlannerError && err.code === "cwd-mismatch",
  );
  assert.throws(
    () => planner.startCompact(r.planId, {
      cwd: "/workspace",
      parentSession: "sess-other",
    }),
    (err) => err instanceof PlannerError && err.code === "resume-session-mismatch",
  );
  assert.equal(
    planner.startCompact(r.planId, compactBinding).parentSession,
    "sess-prev1",
  );
});

// ─── Input validation: unknown values fail closed ────────────────────────────

test("invalid userIntent fails closed", () => {
  const planner = createPlanner();
  assert.throws(
    () => planner.planContinuation(baseInput({ userIntent: "maybe" })),
    (err) => err instanceof PlannerError,
  );
});

test("invalid relationship fails closed", () => {
  const planner = createPlanner();
  assert.throws(
    () => planner.planContinuation(baseInput({ relationship: "cousin" })),
    (err) => err instanceof PlannerError,
  );
});

test("invalid contextValue fails closed", () => {
  const planner = createPlanner();
  assert.throws(
    () => planner.planContinuation(baseInput({ contextValue: "marginal" })),
    (err) => err instanceof PlannerError,
  );
});

test("negative or non-integer correctionCount fails closed", () => {
  const planner = createPlanner();
  assert.throws(() => planner.planContinuation(baseInput({ correctionCount: -1 })), PlannerError);
  assert.throws(() => planner.planContinuation(baseInput({ correctionCount: 1.5 })), PlannerError);
});

test("missing cwd fails closed", () => {
  const planner = createPlanner();
  assert.throws(() => planner.planContinuation(baseInput({ cwd: "" })), PlannerError);
});

test("non-boolean allowCompact fails closed", () => {
  const planner = createPlanner();
  assert.throws(() => planner.planContinuation(baseInput({ allowCompact: "yes" })), PlannerError);
});

test("non-boolean write fails closed", () => {
  const planner = createPlanner();
  assert.throws(() => planner.planContinuation(baseInput({ write: "true" })), PlannerError);
});

// ─── Plan output contract ────────────────────────────────────────────────────

test("plan output contains action, planId, reasonCodes, evidenceState, fallbackAction", () => {
  const planner = createPlanner();
  recordFullEvidence(planner);
  const r = planner.planContinuation(baseInput());
  assert.ok(typeof r.action === "string");
  assert.ok(typeof r.planId === "string" && r.planId.startsWith("plan_"));
  assert.ok(Array.isArray(r.reasonCodes) && r.reasonCodes.length > 0);
  assert.ok(EVIDENCE_STATES_HAS(r.evidenceState));
  assert.ok(typeof r.fallbackAction === "string");
  assert.ok(typeof r.planExpiresAt === "string");
  assert.equal(typeof r.pressureThreshold, "number");
});

function EVIDENCE_STATES_HAS(v) {
  return ["complete", "partial", "unavailable"].includes(v);
}

test("plan binds model and write for consumption enforcement", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh", model: "opus", write: false }));
  // Correct binding succeeds.
  const out = planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: "opus", write: false });
  assert.equal(out.action, ACTIONS.FRESH_HANDOFF);
});

// ─── Fix: model alias case-insensitive comparison ────────────────────────────

test("model drift detection is case-insensitive for known aliases (Opus vs opus)", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { model: "Opus" });
  const r = planner.planContinuation(baseInput({ model: "opus" }));
  // "Opus" and "opus" are the same alias — no drift.
  assert.equal(r.action, ACTIONS.RESUME);
  assert.ok(!r.reasonCodes.includes("drift-detected"));
});

test("plan consumption accepts model alias with different casing (Opus plan, opus consume)", () => {
  const planner = createPlanner();
  const r = planner.planContinuation(baseInput({ userIntent: "fresh", model: "Opus" }));
  const out = planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: "opus", write: true });
  assert.equal(out.action, ACTIONS.FRESH_HANDOFF);
});

test("model drift detection is case-sensitive for native IDs (GLM-5.2 vs glm-5.2)", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { model: "glm-5.2" });
  const r = planner.planContinuation(baseInput({ model: "GLM-5.2" }));
  // Native IDs are case-sensitive — different casing is drift.
  assert.equal(r.action, ACTIONS.FRESH_HANDOFF);
  assert.ok(r.reasonCodes.includes("drift-detected"));
});

// ─── Fix: autoCompact lower threshold takes precedence ───────────────────────

test("autoCompact target ratio lower than 0.75 takes precedence as effective threshold", () => {
  const planner = createPlanner();
  // contextWindow=200000, targetTokens=100000 → ratio=0.5 < 0.75
  // pressure = (80000+20000+50000+10000)/200000 = 0.8 > 0.5 but < 0.75 would not trigger
  // With effective threshold 0.5, pressure 0.8 should trigger high-pressure.
  recordFullEvidence(planner, {
    usage: usage(80000, 20000, 50000, 10000),
    contextWindow: 200000,
    autoCompactTarget: 100000,
  });
  const r = planner.planContinuation(baseInput({
    userIntent: "same_session",
    allowCompact: true,
  }));
  assert.equal(r.action, ACTIONS.COMPACT_RESUME);
  assert.ok(r.reasonCodes.includes("high-pressure"));
  assert.ok(r.pressureThreshold < PRESSURE_THRESHOLD, "effective threshold should be lower than 0.75");
  assert.equal(r.pressureThreshold, 0.5);
});

test("autoCompact target ratio higher than 0.75 does not lower the threshold", () => {
  const planner = createPlanner();
  // contextWindow=200000, targetTokens=180000 → ratio=0.9 > 0.75 → threshold stays 0.75
  recordFullEvidence(planner, {
    usage: usage(80000, 20000, 50000, 10000),
    contextWindow: 200000,
    autoCompactTarget: 180000,
  });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  // pressure 0.8 > 0.75 → compact_resume
  assert.equal(r.action, ACTIONS.COMPACT_RESUME);
  assert.equal(r.pressureThreshold, PRESSURE_THRESHOLD);
});

// ─── Fix: completeCompact rejects already-failed plan ────────────────────────

test("completeCompact rejects a plan that already failed compact", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  planner.startCompact(r.planId, compactBinding);
  planner.completeCompact(r.planId, { ok: false });
  // Second completeCompact must be rejected — cannot revive a failed plan.
  assert.throws(
    () => planner.completeCompact(r.planId, { ok: true, hasNewBoundary: true }),
    (err) => err instanceof PlannerError && err.code === "compact-failed-replan",
  );
});

// ─── Fix: fallback-to-resume replay rejection and state consistency ──────────

test("fallback-to-resume plan rejects replay after consumption", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  planner.startCompact(r.planId, compactBinding);
  planner.completeCompact(r.planId, { ok: true, hasNewBoundary: false });
  // First consumption succeeds.
  planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" });
  // Replay must be rejected.
  assert.throws(
    () => planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" }),
    (err) => err instanceof PlannerError && err.code === "plan-already-consumed",
  );
});

test("fallback-to-resume sets compactConsumed for inspectPlan consistency", () => {
  const planner = createPlanner();
  recordFullEvidence(planner, { usage: usage(150000, 50000, 100000, 20000), contextWindow: 200000 });
  const r = planner.planContinuation(baseInput({ userIntent: "same_session", allowCompact: true }));
  planner.startCompact(r.planId, compactBinding);
  planner.completeCompact(r.planId, { ok: true, hasNewBoundary: false });
  planner.consumeDelegatePlan(r.planId, { cwd: "/workspace", model: null, write: true, resumeSession: "sess-prev1" });
  const inspection = planner.inspectPlan(r.planId);
  assert.equal(inspection.action, ACTIONS.RESUME);
  assert.equal(inspection.consumed, true);
  assert.equal(inspection.compactConsumed, true, "compactConsumed should be true for consistency after fallback");
  assert.equal(inspection.compactCompacted, true);
});
