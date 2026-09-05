import type { DiagnosticDisplayPayload } from "../lib/diagnosticPayload";

export function DiagnosticResult({ payload }: { payload: DiagnosticDisplayPayload }) {
  return (
    <div className="result-panel">
      <h2>Lesson media diagnostic result</h2>
      <p className="hint">
        Sanitized response from <code>GET /api/v1/course_lessons/{"{lesson_id}"}</code>.
        The raw signed video token value is never fetched into the UI layer for
        display — only its presence is shown.
      </p>
      <pre className="json-block">{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
