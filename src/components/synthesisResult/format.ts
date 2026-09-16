/**
 * Phase 4M follow-up — shared formatting/download helpers behind both
 * CourseIntelligence's synthesis viewer and the Run History result viewer.
 * Extracted verbatim from CourseIntelligence.tsx; no behavior changes.
 */
import type { CoursePlaybook, SourceRef } from "../../lib/synthesisApi";

export function formatCost(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)} min`;
}

export function sourceTitle(sources: SourceRef[]): string {
  return sources.map((s) => `${s.lessonTitle}${s.startTimestamp ? ` @ ${s.startTimestamp}` : ""}: ${s.evidence}`).join("\n");
}

export function slugify(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

export function downloadJsonFile(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(text: string, filename: string, mimeType = "text/plain"): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function playbookToMarkdown(playbook: CoursePlaybook): string {
  return [`# ${playbook.title}`, ...(playbook.sections ?? []).map((s) => `\n## ${s.title}\n\n${s.content}`)].join("\n");
}
