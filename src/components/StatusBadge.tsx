import type { AnalysisJobStatus } from "../lib/courseApi";

const STATUS_LABELS: Record<AnalysisJobStatus, string> = {
  NOT_ANALYZED: "Not analyzed",
  QUEUED: "Queued",
  RETRIEVING: "Retrieving",
  PREPARING_VIDEO: "Preparing video",
  UPLOADING: "Uploading",
  GEMINI_PROCESSING: "Processing on Gemini",
  ANALYZING: "Analyzing",
  VALIDATING: "Validating",
  COMPLETED: "Completed",
  NO_STRATEGY: "No strategy",
  FAILED: "Failed",
  AUTH_REQUIRED: "Auth required",
  CANCELLED: "Cancelled",
};

const STATUS_CLASSES: Record<AnalysisJobStatus, string> = {
  NOT_ANALYZED: "status-neutral",
  QUEUED: "status-queued",
  RETRIEVING: "status-processing",
  PREPARING_VIDEO: "status-processing",
  UPLOADING: "status-processing",
  GEMINI_PROCESSING: "status-processing",
  ANALYZING: "status-processing",
  VALIDATING: "status-processing",
  COMPLETED: "status-success",
  NO_STRATEGY: "status-neutral",
  FAILED: "status-error",
  AUTH_REQUIRED: "status-error",
  CANCELLED: "status-neutral",
};

export function StatusBadge({ status }: { status: AnalysisJobStatus }) {
  return <span className={`status-badge ${STATUS_CLASSES[status]}`}>{STATUS_LABELS[status]}</span>;
}
