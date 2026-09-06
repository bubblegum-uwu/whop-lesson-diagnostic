/**
 * Client for Phase 3.4's course-strategy-synthesis endpoints. Same
 * conventions as courseApi.ts: every call requires the operator's current
 * Whop access token as a bearer header.
 */

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
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

export interface SynthesisStatus {
  course: { title: string } | null;
  counts: { totalLessons: number; analyzed: number; processing: number; queued: number; failed: number };
  noStandaloneSetupLessons: NoStandaloneSetupLesson[];
  latestRun: SynthesisRunSummary | null;
  latestCompletedRun: SynthesisRunSummary | null;
  isOutOfDate: boolean;
  canSynthesizeNow: boolean;
}

export async function getSynthesisStatus(backendUrl: string, accessToken: string): Promise<SynthesisStatus | null> {
  const res = await fetch(`${backendUrl}/api/course/synthesis-status`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to load synthesis status (${res.status}).`);
  const body = (await res.json()) as SynthesisStatus & { course: { title: string } | null };
  return body.course ? body : null;
}

export interface SynthesizeResult {
  created: boolean;
  run: SynthesisRunSummary;
}

export async function synthesizeCourse(backendUrl: string, accessToken: string, force = false): Promise<SynthesizeResult> {
  const res = await fetch(`${backendUrl}/api/course/synthesize`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
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

export interface SynthesizedRule {
  description: string;
  classification: "explicit" | "inferred" | "visual" | "synthesized";
  supportLevel: SupportLevel;
  supportCount: number;
  sources: SourceRef[];
  conflictSources: SourceRef[];
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
  variants: { description: string; sourceLessonIds: number[] }[];
  examples: { description: string; sourceLessonId: number }[];
  ambiguities: string[];
  conflicts: Conflict[];
  sourceLessonIds: number[];
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

export interface PlaybookSection {
  key: string;
  title: string;
  content: string;
}

export type FrameworkCoverageStatus = "COMPLETE" | "PARTIAL";

export interface FrameworkCoverage {
  status: FrameworkCoverageStatus;
  standaloneStrategyLessonsAnalyzed: number;
  lessonsWithoutStandaloneSetup: number;
  lessonsMissingSupportingKnowledgeExtraction: number;
  missingSupportingKnowledgeLessonIds: number[];
  missingSupportingKnowledgeLessonTitles: string[];
  coverageNote: string;
}

export interface CoursePlaybook {
  title: string;
  sections: PlaybookSection[];
  conflictsAndAmbiguities: Conflict[];
  frameworkCoverage: FrameworkCoverage;
}

export interface DecisionNode {
  id: string;
  type: "start" | "decision" | "action" | "end";
  label: string;
  description: string | null;
  next: string[];
  branches: { label: string; next: string }[];
}

export interface DecisionFramework {
  nodes: DecisionNode[];
  readableSteps: string[];
}

export interface CourseSynthesisData {
  run: SynthesisRunSummary;
  clusters: ClusterInfo[];
  canonicalStrategies: CanonicalStrategyInfo[];
  coreFramework: CoreFramework | null;
  playbook: CoursePlaybook | null;
  decisionFramework: DecisionFramework | null;
}

export async function getCourseSynthesis(backendUrl: string, accessToken: string): Promise<CourseSynthesisData | null> {
  const res = await fetch(`${backendUrl}/api/course/synthesis`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to load course synthesis (${res.status}).`);
  const body = (await res.json()) as CourseSynthesisData & { run: SynthesisRunSummary | null };
  return body.run ? (body as CourseSynthesisData) : null;
}
