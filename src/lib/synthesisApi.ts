/**
 * Client for Phase 3.4's course-strategy-synthesis endpoints. Same
 * conventions as courseApi.ts: every call requires the Knovera session
 * token (Phase 4D) — never a Whop token. Reading or launching synthesis
 * never requires an active Whop connection; see http/app.ts's route
 * classification (courseSynthesis.ts only uses whopCourseId as a stable
 * string identifier, never a live Whop API call).
 */
import type { KnowledgeItemScope, NumericalValue } from "./courseApi";

function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export type SynthesisRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

/** Mirrors backend/src/synthesis/progress.ts's PROGRESS_STAGE_ORDER exactly. */
export type SynthesisProgressStage =
  | "NORMALIZING"
  | "CLUSTERING"
  | "CANONICALIZING"
  | "CORE_FRAMEWORK"
  | "PLAYBOOK"
  | "DECISION_FRAMEWORK"
  | "VALIDATING";

/** "none" = fresh, no warning. "waiting_for_update"/"no_recent_heartbeat" = the browser just hasn't heard from the worker in a while — never means failure. "waiting_for_recovery" = the worker's lease itself expired (a crashed execution) and another worker still needs to pick the run back up. */
export type HeartbeatTier = "none" | "waiting_for_update" | "no_recent_heartbeat" | "waiting_for_recovery";

export interface SynthesisRunSummary {
  runId: string;
  status: SynthesisRunStatus;
  currentStage: string | null;
  sourceAnalysisHash: string;
  model: string;
  startedAt: string | null;
  completedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  errorType: string | null;
  sanitizedError: string | null;
  createdAt: string;
  updatedAt: string;
  /** 1-based, out of totalStages — "Stage 3 of 7". */
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  /** 0-100, deterministic stage-weighted — never a fabricated per-second estimate. */
  overallProgress: number;
  /** 0-100 within the current stage, or null when that stage has no countable work (see isIndeterminate). */
  stageProgress: number | null;
  /** True when the current stage has real completed/total counts to show (e.g. "2 of 4 complete"). */
  isCountable: boolean;
  /** True when the current stage is a single indeterminate Gemini call — never show a fabricated percentage for it. */
  isIndeterminate: boolean;
  completedItems: number | null;
  totalItems: number | null;
  /** A short display label only (e.g. a canonical strategy's name) — never prompt content. */
  currentItem: string | null;
  lastHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatTier: HeartbeatTier;
}

export interface NoStandaloneSetupLesson {
  lessonId: number;
  title: string;
}

/** Phase 3.5B — whether the FULL course is current v2/current-fingerprint before running production synthesis. Read-only/informational here; does not itself block POST /api/course/synthesize. */
export interface SynthesisPreflight {
  lessonCount: number;
  latestSuccessfulAnalysisCount: number;
  currentAnalysisCount: number;
  staleAnalysisCount: number;
  missingAnalysisCount: number;
  staleLessonIds: number[];
  staleLessonTitles: string[];
  missingLessonIds: number[];
  missingLessonTitles: string[];
  ready: boolean;
}

export interface SynthesisStatus {
  course: { title: string } | null;
  counts: { totalLessons: number; analyzed: number; processing: number; queued: number; failed: number };
  noStandaloneSetupLessons: NoStandaloneSetupLesson[];
  latestRun: SynthesisRunSummary | null;
  latestCompletedRun: SynthesisRunSummary | null;
  isOutOfDate: boolean;
  canSynthesizeNow: boolean;
  preflight: SynthesisPreflight;
}

export async function getSynthesisStatus(backendUrl: string, knoveraToken: string): Promise<SynthesisStatus | null> {
  const res = await fetch(`${backendUrl}/api/course/synthesis-status`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) throw new Error(`Failed to load synthesis status (${res.status}).`);
  const body = (await res.json()) as SynthesisStatus & { course: { title: string } | null };
  return body.course ? body : null;
}

export interface SynthesizeResult {
  created: boolean;
  run: SynthesisRunSummary;
}

export async function synthesizeCourse(backendUrl: string, knoveraToken: string, force = false): Promise<SynthesizeResult> {
  const res = await fetch(`${backendUrl}/api/course/synthesize`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(body?.error?.message ?? `Failed to start synthesis (${res.status}).`);
  return body as SynthesizeResult;
}

export interface SourceRef {
  lessonId: number;
  lessonTitle: string;
  strategyInstanceId: number | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  evidence: string;
}

export type SupportLevel = "SINGLE_SOURCE" | "MULTI_SOURCE" | "REPEATED_EXPLICIT" | "VARIANT" | "CONFLICTING" | "INFERRED";

/** Real-audit fix (Phase 3.5B v4) — WHY `scope` is null matters as much as the fact itself. See backend scopeBasis.ts. "VERIFIED_GLOBAL": every citation was scope-aware and none were scoped — trustworthy. "SCOPED": at least one citation was scoped — `scope` is their union. "UNVERIFIED": the rule cites no scope-aware evidence at all (e.g. only pre-3.5B per-lesson Strategy rules, never scope-tagged) — must never be treated as safely global even though `scope` is also null in this case. */
export type ScopeBasis = "VERIFIED_GLOBAL" | "SCOPED" | "UNVERIFIED";

export interface SynthesizedRule {
  description: string;
  classification: "explicit" | "inferred" | "visual" | "synthesized";
  supportLevel: SupportLevel;
  supportCount: number;
  sources: SourceRef[];
  conflictSources: SourceRef[];
  /** Phase 3.5B — deterministically attached from whichever cited rich-knowledge source(s) support this rule; empty for a rule derived only from a pre-3.5B strategy-instance rule. */
  exceptions: string[];
  numericalValues: NumericalValue[];
  /** The union of every cited source's scope — null when this rule carries no scope-bearing citation. */
  scope: KnowledgeItemScope | null;
  /** Real-audit fix (Phase 3.5B v4) — see ScopeBasis above. Optional so responses predating this field still type-check; absence should be treated the same as the backend's effectiveScopeBasis fallback (null scope = VERIFIED_GLOBAL, non-null = SCOPED). */
  scopeBasis?: ScopeBasis;
}

export interface Conflict {
  description: string;
  sources: SourceRef[];
}

export interface CanonicalStrategy {
  name: string;
  purpose: string;
  markets: string[];
  timeframes: string[];
  marketContext: SynthesizedRule[];
  prerequisites: SynthesizedRule[];
  setup: SynthesizedRule[];
  entryRules: SynthesizedRule[];
  confirmationRules: SynthesizedRule[];
  stopLossRules: SynthesizedRule[];
  profitTargetRules: SynthesizedRule[];
  tradeManagementRules: SynthesizedRule[];
  invalidationRules: SynthesizedRule[];
  noTradeConditions: SynthesizedRule[];
  visualDiscretionaryRules: SynthesizedRule[];
  /**
   * Phase 3.5B — populated from strategy-scoped rich KnowledgeItems (see
   * strategyScopeMapping.ts) drawn from ANY contributing lesson, not just
   * this cluster's own strategy instances. Same SynthesizedRule shape as
   * the 11 categories above.
   */
  riskManagementRules: SynthesizedRule[];
  positionSizingRules: SynthesizedRule[];
  scalingInRules: SynthesizedRule[];
  scalingOutRules: SynthesizedRule[];
  runnerManagementRules: SynthesizedRule[];
  warnings: SynthesizedRule[];
  instructorPreferences: SynthesizedRule[];
  variants: { description: string; sourceLessonIds: number[] }[];
  examples: { description: string; sourceLessonId: number }[];
  ambiguities: string[];
  conflicts: Conflict[];
  /** Real-audit fix (Phase 3.5B) — lessons whose standalone strategy instance is a member of this cluster (taught the setup), computed deterministically. Distinct from `supportingKnowledgeLessonIds` below — see Source Index. */
  sourceLessonIds: number[];
  /** Real-audit fix (Phase 3.5B) — lessons that contributed matched strategy-scoped supporting knowledge to this cluster WITHOUT necessarily teaching the standalone setup themselves. */
  supportingKnowledgeLessonIds: number[];
}

export interface ClusterInfo {
  clusterId: number;
  clusterKey: string;
  canonicalName: string;
  cluster: {
    clusterKey: string;
    proposedCanonicalName: string;
    memberInstanceIds: number[];
    similarityRationale: string;
    differencesNotes: string;
  };
}

export interface CanonicalStrategyInfo {
  canonicalStrategyId: number;
  clusterId: number;
  name: string;
  strategy: CanonicalStrategy;
}

export interface CoreFrameworkSection {
  key: string;
  title: string;
  rules: SynthesizedRule[];
}

export interface CoreFramework {
  sections: CoreFrameworkSection[];
}

/** Real-audit fix (Phase 3.5B v5) — which applicability rules a section is held to by the audit (see backend playbookApplicabilityAudit.ts). Assigned deterministically in code from the section's key, never chosen by Gemini. */
export type ApplicabilityPolicy = "VERIFIED_GLOBAL_ONLY" | "SCOPED" | "DESCRIPTIVE_MIXED" | "CONFLICT_DOCUMENTATION";

export interface PlaybookSection {
  key: string;
  title: string;
  content: string;
  /** Real-audit fix (Phase 3.5B v5) — which pooled CoreFramework/canonical-strategy rule(s) this section's prose is grounded in; Gemini cites these, never a scope/applicability claim directly. Optional — absent for deterministic (code-generated) sections. */
  sourceKeys?: string[];
  /** Deterministically derived as the union of every cited source's own scope — never self-reported by Gemini. */
  scope?: KnowledgeItemScope;
  scopeBasis?: ScopeBasis;
  applicabilityPolicy?: ApplicabilityPolicy;
}

export type FrameworkCoverageStatus = "COMPLETE" | "PARTIAL";

export interface FrameworkCoverage {
  status: FrameworkCoverageStatus;
  standaloneStrategyLessonsAnalyzed: number;
  lessonsWithoutStandaloneSetup: number;
  lessonsMissingSupportingKnowledgeExtraction: number;
  missingSupportingKnowledgeLessonIds: number[];
  missingSupportingKnowledgeLessonTitles: string[];
  /** Phase 3.5B — human-readable labels of tracked knowledge dimensions (risk management, position sizing, psychology, etc.) with zero supporting evidence anywhere in the course; this, not lesson/strategy counts, now drives `status`. */
  missingFrameworkDimensions: string[];
  coverageNote: string;
}

/** Real-audit fix (Phase 3.5B) — a signal fully independent of FrameworkCoverage.status: whether every distinct strategy name referenced by scope.strategies was resolved to a canonical-strategy cluster. Never infer one from the other's wording. */
export interface StrategyScopeMappingSummary {
  distinctRawNameCount: number;
  matchedRawNameCount: number;
  unmatchedRawNameCount: number;
  matchedRawNames: string[];
  unmatchedRawNames: string[];
  totalStrategyScopedItemCount: number;
  matchedItemCount: number;
  unmatchedItemCount: number;
  completeness: FrameworkCoverageStatus;
}

/**
 * Real-audit fix (Phase 3.5B v3-v5) — a playbook section broadening known
 * scoped/unverified material into an absolute/universal claim (see backend
 * playbookApplicabilityAudit.ts). v5 replaced a single, overly-broad
 * "universalSectionScopeLeaks" gate (it also fired on sections like
 * scoped_execution_checklists/conflicts_and_ambiguities that are SUPPOSED
 * to discuss scoped material) with three policy-aware, differently-severe
 * categories on CoursePlaybook below — see each field's own doc comment.
 */
export interface ApplicabilityLeak {
  sectionKey: string;
  matchedTerms: string[];
  /** Descriptions of non-global rules this section's prose significantly overlaps under absolute-claim language, even with zero literal vocabulary-term matches. */
  matchedNonGlobalRules: string[];
}

export interface CoursePlaybook {
  title: string;
  sections: PlaybookSection[];
  conflictsAndAmbiguities: Conflict[];
  frameworkCoverage: FrameworkCoverage;
  strategyScopeMapping: StrategyScopeMappingSummary;
  /** A non-exempt section broadened a KNOWN scoped restriction into an absolute/universal claim — the clearest, most severe leak. */
  universalApplicabilityLeaks: ApplicabilityLeak[];
  /** A non-exempt section asserted something as universal resting only on UNVERIFIED evidence — a real gap, but weaker than contradicting known evidence. */
  unverifiedUniversalClaims: ApplicabilityLeak[];
  /** A SCOPED-policy section (e.g. "scoped_execution_checklists") used absolute-claim language without ever stating its own declared scope. */
  scopedApplicabilityLeaks: ApplicabilityLeak[];
}

export interface DecisionNode {
  id: string;
  type: "start" | "decision" | "action" | "end";
  label: string;
  description: string | null;
  next: string[];
  branches: { label: string; next: string }[];
  /** Real-audit fix (Phase 3.5B v3) — the pooled CoreFramework/canonical-strategy rule key(s) this node was actually built from; `scope` below is derived deterministically as the union of these keys' own already-known scope, never self-reported by Gemini (see decisionFramework.ts). */
  sourceKeys: string[];
  /** All arrays empty means this node's known scope carries no restriction; a non-empty array means it's conditioned on that restriction and must never sit on the unconditional path before strategy selection (see decisionScopeAudit.ts). Empty here does NOT by itself mean "safe to treat as global" — see `scopeBasis`. */
  scope: KnowledgeItemScope;
  /** Real-audit fix (Phase 3.5B v4) — see ScopeBasis above. A node can have an empty `scope` yet still be "UNVERIFIED" (built from citations with no scope-aware evidence at all), in which case it must be treated the same as a scoped node for gate-placement purposes. */
  scopeBasis: ScopeBasis;
}

export interface DecisionFramework {
  nodes: DecisionNode[];
  readableSteps: string[];
  /** Real-audit fix (Phase 3.5B v3) — deterministic post-check output: any entry here is a bug in the returned graph — either a scoped node structurally placed on the unconditional global path ("scoped_source"), or a substantive node citing no source at all ("ungrounded", never treated as global by default). Should be empty by construction. */
  scopeLeaks: { nodeId: string; label: string; reason: "ungrounded" | "unverified_source" | "scoped_source"; scope: KnowledgeItemScope }[];
  /** Real-audit fix (v9, Part 3) — the `readableSteps` counterpart to `scopeLeaks`: a plain-text step whose wording closely echoes a known SCOPED ("scoped_mechanic") or UNVERIFIED ("unverified_mechanic") rule without deferring to the selected strategy's own rules. Participates in the same overall scope-fidelity PASS/FAIL as `scopeLeaks`. Should be empty by construction. */
  readableStepLeaks: { stepIndex: number; step: string; reason: "scoped_mechanic" | "unverified_mechanic"; matchedNonGlobalRules: string[] }[];
}

export interface CourseSynthesisData {
  run: SynthesisRunSummary;
  clusters: ClusterInfo[];
  canonicalStrategies: CanonicalStrategyInfo[];
  coreFramework: CoreFramework | null;
  playbook: CoursePlaybook | null;
  decisionFramework: DecisionFramework | null;
}

export async function getCourseSynthesis(backendUrl: string, knoveraToken: string): Promise<CourseSynthesisData | null> {
  const res = await fetch(`${backendUrl}/api/course/synthesis`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) throw new Error(`Failed to load course synthesis (${res.status}).`);
  const body = (await res.json()) as CourseSynthesisData & { run: SynthesisRunSummary | null };
  return body.run ? (body as CourseSynthesisData) : null;
}

/**
 * Phase 4E — the project-aware synthesis client. The route/project now
 * determines the synthesis input (see backend/src/http/routes/
 * projectSynthesis.ts): these calls resolve a project's own course via
 * `courses.project_id`, never the deployment's globally configured Whop
 * course. Same Knovera-only auth conventions as above — no Whop token, and
 * reading/launching synthesis never requires an active Whop connection.
 */
export type ProjectSynthesisUnsupportedReason = "unsupported_project_type" | "no_source" | "multiple_sources";

/** Discriminated on `status` — TRADING_STRATEGIES + exactly one course resolves to "ready"; every other shape is a clean, non-fabricated state the UI renders directly (see CourseIntelligence.tsx). */
export type ProjectSynthesisStatus =
  | {
      status: ProjectSynthesisUnsupportedReason;
      projectId: number;
      projectType: string;
      sourceCount: number;
      sourceCourseId: null;
      sourceName: null;
      course: null;
      counts: null;
      noStandaloneSetupLessons: NoStandaloneSetupLesson[];
      latestRun: null;
      latestCompletedRun: null;
      isOutOfDate: false;
      canSynthesizeNow: false;
      preflight: null;
    }
  | {
      status: "ready";
      projectId: number;
      projectType: string;
      sourceCount: number;
      sourceCourseId: number;
      sourceName: string;
      course: { title: string };
      counts: { totalLessons: number; analyzed: number; processing: number; queued: number; failed: number };
      noStandaloneSetupLessons: NoStandaloneSetupLesson[];
      latestRun: SynthesisRunSummary | null;
      latestCompletedRun: SynthesisRunSummary | null;
      isOutOfDate: boolean;
      canSynthesizeNow: boolean;
      preflight: SynthesisPreflight;
    };

export async function getProjectSynthesisStatus(backendUrl: string, knoveraToken: string, projectId: number): Promise<ProjectSynthesisStatus> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis/status`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) throw new Error(`Failed to load project synthesis status (${res.status}).`);
  return (await res.json()) as ProjectSynthesisStatus;
}

export async function synthesizeProject(backendUrl: string, knoveraToken: string, projectId: number, force = false): Promise<SynthesizeResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(body?.error?.message ?? `Failed to start synthesis (${res.status}).`);
  return body as SynthesizeResult;
}

/** Discriminated on `status` — a resolved project/course with no completed run yet is "no_run" (sourceCourseId/sourceName known, run null); everything else mirrors ProjectSynthesisStatus's non-ready shapes. */
export type ProjectSynthesisData =
  | {
      status: ProjectSynthesisUnsupportedReason;
      projectId: number;
      projectType: string;
      sourceCount: number;
      sourceCourseId: null;
      sourceName: null;
      run: null;
    }
  | {
      status: "no_run";
      projectId: number;
      projectType: string;
      sourceCount: number;
      sourceCourseId: number;
      sourceName: string;
      run: null;
    }
  | {
      status: "ready";
      projectId: number;
      projectType: string;
      sourceCount: number;
      sourceCourseId: number;
      sourceName: string;
      run: SynthesisRunSummary;
      clusters: ClusterInfo[];
      canonicalStrategies: CanonicalStrategyInfo[];
      coreFramework: CoreFramework | null;
      playbook: CoursePlaybook | null;
      decisionFramework: DecisionFramework | null;
    };

export async function getProjectSynthesis(backendUrl: string, knoveraToken: string, projectId: number): Promise<ProjectSynthesisData> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) throw new Error(`Failed to load project synthesis (${res.status}).`);
  return (await res.json()) as ProjectSynthesisData;
}
