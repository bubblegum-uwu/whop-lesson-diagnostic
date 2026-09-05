import type { LessonFetchOutcome } from "../lib/whopApi";

function headingFor(outcome: Exclude<LessonFetchOutcome, { kind: "success" }>): string {
  switch (outcome.kind) {
    case "unauthorized":
      return "AUTHENTICATION FAILED";
    case "forbidden":
      return "AUTHENTICATED BUT ACCESS DENIED";
    case "not_found":
      return "LESSON NOT FOUND";
    case "other_error":
      return `WHOP API ERROR (HTTP ${outcome.status})`;
  }
}

export function ErrorResult({
  outcome,
}: {
  outcome: Exclude<LessonFetchOutcome, { kind: "success" }>;
}) {
  return (
    <div className="error-panel" role="alert">
      <h2>{headingFor(outcome)}</h2>
      <dl>
        <dt>HTTP status</dt>
        <dd>{outcome.status}</dd>
        <dt>Whop error type</dt>
        <dd>{outcome.error.type}</dd>
        {outcome.error.code && (
          <>
            <dt>Whop error code</dt>
            <dd>{outcome.error.code}</dd>
          </>
        )}
        <dt>Whop error message</dt>
        <dd>{outcome.error.message}</dd>
      </dl>
      <p className="hint">No workaround was attempted. This status is preserved as-is.</p>
    </div>
  );
}
