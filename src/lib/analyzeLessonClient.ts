/**
 * Calls the Phase 2 backend's POST /api/analyze-lesson endpoint, which
 * streams Server-Sent Events: a sequence of stage updates, then either a
 * final result or an error.
 *
 * The Whop access token is sent ONLY in the Authorization header, exactly
 * once per call, and is never logged or stored by this module.
 */

export interface StageEvent {
  type: "stage";
  stage: string;
  label: string;
}
export interface ResultEvent {
  type: "result";
  payload: unknown;
}
export interface ErrorEvent {
  type: "error";
  message: string;
  stage?: string;
}
export type AnalyzeLessonEvent = StageEvent | ResultEvent | ErrorEvent;

export interface AnalyzeLessonCallbacks {
  onStage?: (event: StageEvent) => void;
  onResult?: (event: ResultEvent) => void;
  onError?: (event: ErrorEvent) => void;
}

export async function streamAnalyzeLesson(
  backendUrl: string,
  lessonUrl: string,
  whopAccessToken: string,
  callbacks: AnalyzeLessonCallbacks,
): Promise<void> {
  const res = await fetch(`${backendUrl}/api/analyze-lesson`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whopAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ lessonUrl }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    callbacks.onError?.({
      type: "error",
      message: text || `Backend request failed with status ${res.status}.`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      const jsonText = dataLine.slice("data:".length).trim();
      let event: AnalyzeLessonEvent;
      try {
        event = JSON.parse(jsonText);
      } catch {
        continue;
      }

      if (event.type === "stage") callbacks.onStage?.(event);
      else if (event.type === "result") callbacks.onResult?.(event);
      else if (event.type === "error") callbacks.onError?.(event);
    }
  }
}
