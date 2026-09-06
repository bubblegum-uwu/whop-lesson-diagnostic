import type { AnalysisSummary } from "../lib/courseApi";

function formatCost(value: number | null): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

function formatSeconds(value: number | null): string {
  if (value == null) return "—";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}m ${seconds}s`;
}

const TILES: { key: keyof AnalysisSummary; label: string }[] = [
  { key: "totalLessons", label: "Total Lessons" },
  { key: "analyzed", label: "Analyzed" },
  { key: "strategyLessons", label: "Strategy Lessons" },
  { key: "noStrategy", label: "No Standalone Setup" },
  { key: "processing", label: "Processing" },
  { key: "queued", label: "Queued" },
  { key: "failed", label: "Failed" },
  { key: "remaining", label: "Remaining" },
];

export function DashboardSummary({ summary }: { summary: AnalysisSummary | null }) {
  if (!summary) return null;

  return (
    <div className="dashboard-summary">
      <div className="dashboard-tiles">
        {TILES.map(({ key, label }) => (
          <div className="dashboard-tile" key={key}>
            <div className="dashboard-tile-value">{summary[key] as number}</div>
            <div className="dashboard-tile-label">{label}</div>
          </div>
        ))}
      </div>
      <div className="dashboard-spend">
        <span>
          Course Gemini Spend: <strong>{formatCost(summary.totalCost)}</strong>
        </span>
        <span>
          Average Cost / Lesson: <strong>{formatCost(summary.averageCostPerLesson)}</strong>
        </span>
        <span>
          Average Processing Time: <strong>{formatSeconds(summary.averageProcessingSeconds)}</strong>
        </span>
      </div>
    </div>
  );
}
