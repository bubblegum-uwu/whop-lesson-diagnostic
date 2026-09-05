import { useState } from "react";
import { streamAnalyzeLesson } from "../lib/analyzeLessonClient";
import type { LessonStrategyAnalysis, StrategyRule } from "../lib/strategyTypes";
import { RULE_SECTIONS } from "../lib/strategyTypes";

const ALL_STAGES = [
  "retrieving_lesson",
  "resolving_secure_video",
  "preparing_video",
  "uploading_to_gemini",
  "analyzing_lesson",
  "validating_result",
] as const;

const STAGE_LABELS: Record<string, string> = {
  retrieving_lesson: "Retrieving lesson",
  resolving_secure_video: "Resolving secure video",
  preparing_video: "Preparing video",
  uploading_to_gemini: "Uploading to Gemini",
  analyzing_lesson: "Analyzing lesson",
  validating_result: "Validating result",
};

type State =
  | { phase: "idle" }
  | { phase: "running"; completedStages: string[]; currentStage: string | null }
  | { phase: "done"; result: LessonStrategyAnalysis }
  | { phase: "error"; message: string; stage?: string };

export interface AnalyzeLessonProps {
  backendUrl: string;
  lessonUrl: string;
  /** Held only in memory by the parent; never persisted. Sent only as an Authorization header. */
  accessToken: string;
}

function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function RuleList({ rules }: { rules: StrategyRule[] }) {
  if (rules.length === 0) return <p className="rule-empty">None identified.</p>;
  return (
    <ul className="rule-list">
      {rules.map((rule, i) => (
        <li key={i} className="rule-item">
          <div className="rule-header">
            <span className={`badge badge-${rule.classification}`}>{rule.classification}</span>
            <span className="confidence">{confidencePercent(rule.confidence)} confidence</span>
            <span className="timestamp">
              {rule.start_timestamp}
              {rule.end_timestamp ? `–${rule.end_timestamp}` : ""}
            </span>
          </div>
          <p className="rule-description">{rule.description}</p>
          <p className="rule-evidence">{rule.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

function ResultView({ result }: { result: LessonStrategyAnalysis }) {
  function downloadJson() {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lesson-strategy-analysis.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="strategy-result">
      <div className="strategy-result-header">
        <h2>{result.lesson.title}</h2>
        {result.lesson.duration_seconds != null && (
          <p className="hint">Duration: {Math.round(result.lesson.duration_seconds / 60)} min</p>
        )}
        <button onClick={downloadJson}>Download JSON</button>
      </div>

      {!result.strategy_found && (
        <div className="no-strategy-box">
          <strong>No trading strategy identified.</strong>
          <p className="hint">
            Gemini determined this lesson is introductory or does not teach a concrete,
            extractable trading strategy, so no rules were fabricated.
          </p>
        </div>
      )}

      {result.strategies.map((strategy, i) => (
        <div key={i} className="strategy-card">
          <h3>{strategy.strategy_name}</h3>
          <div className="strategy-meta">
            {strategy.market_or_instrument.length > 0 && (
              <span>Market: {strategy.market_or_instrument.join(", ")}</span>
            )}
            {strategy.timeframes.length > 0 && <span>Timeframes: {strategy.timeframes.join(", ")}</span>}
            {strategy.indicators.length > 0 && <span>Indicators: {strategy.indicators.join(", ")}</span>}
          </div>

          {RULE_SECTIONS.map(({ key, label }) => (
            <div key={key} className="rule-section">
              <h4>{label}</h4>
              <RuleList rules={strategy[key] as StrategyRule[]} />
            </div>
          ))}

          {strategy.examples_shown.length > 0 && (
            <div className="rule-section">
              <h4>Examples shown</h4>
              <ul className="plain-list">
                {strategy.examples_shown.map((ex, i2) => (
                  <li key={i2}>{ex}</li>
                ))}
              </ul>
            </div>
          )}

          {strategy.ambiguities.length > 0 && (
            <div className="rule-section">
              <h4>Ambiguities</h4>
              <ul className="plain-list">
                {strategy.ambiguities.map((a, i2) => (
                  <li key={i2}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function AnalyzeLesson({ backendUrl, lessonUrl, accessToken }: AnalyzeLessonProps) {
  const [state, setState] = useState<State>({ phase: "idle" });

  async function handleAnalyze() {
    setState({ phase: "running", completedStages: [], currentStage: ALL_STAGES[0] });

    await streamAnalyzeLesson(backendUrl, lessonUrl, accessToken, {
      onStage: (event) => {
        setState((prev) => {
          if (prev.phase !== "running") return prev;
          const completed = prev.currentStage
            ? [...prev.completedStages, prev.currentStage]
            : prev.completedStages;
          return { phase: "running", completedStages: completed, currentStage: event.stage };
        });
      },
      onResult: (event) => {
        setState({ phase: "done", result: event.payload as LessonStrategyAnalysis });
      },
      onError: (event) => {
        setState({ phase: "error", message: event.message, stage: event.stage });
      },
    });
  }

  if (state.phase === "idle") {
    return (
      <div className="analyze-section">
        <button onClick={handleAnalyze}>Analyze this lesson with Gemini</button>
      </div>
    );
  }

  if (state.phase === "running") {
    return (
      <div className="analyze-section">
        <ul className="stage-list">
          {ALL_STAGES.map((stage) => {
            const isDone = state.completedStages.includes(stage);
            const isCurrent = state.currentStage === stage;
            return (
              <li key={stage} className={isDone ? "stage-done" : isCurrent ? "stage-current" : "stage-pending"}>
                {STAGE_LABELS[stage]}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="analyze-section">
        <div className="error-panel" role="alert">
          <h2>ANALYSIS FAILED</h2>
          {state.stage && <p className="hint">Stage: {STAGE_LABELS[state.stage] ?? state.stage}</p>}
          <p>{state.message}</p>
        </div>
        <button onClick={() => setState({ phase: "idle" })}>Try again</button>
      </div>
    );
  }

  return (
    <div className="analyze-section">
      <ResultView result={state.result} />
    </div>
  );
}
