import type { Request, Response } from "express";
import type { Pool } from "pg";
import { listEventsSince } from "../../db/jobEventsRepo.js";

export interface AnalysisEventsRouteDeps {
  pool: Pool;
  pollIntervalMs?: number;
}

/**
 * GET /api/analysis/events — a live-notification-only layer over Postgres,
 * which remains the source of truth. Polls for job_events rows newer than
 * the last tick and pushes them as SSE frames (fetch()+ReadableStream on the
 * frontend, same pattern as the existing analyze-lesson stream — never
 * native EventSource, so the operator's bearer token stays in a header, not
 * a URL). On disconnect the frontend reconnects and reloads full state from
 * GET /api/course/lessons before resubscribing — this stream is never relied
 * on as the sole record of what happened.
 */
export function createAnalysisEventsHandler(deps: AnalysisEventsRouteDeps) {
  return function analysisEventsHandler(req: Request, res: Response): void {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let since = new Date();
    const interval = setInterval(() => {
      listEventsSince(deps.pool, since)
        .then((events) => {
          if (events.length > 0) {
            since = events[events.length - 1]!.createdAt;
            res.write(`data: ${JSON.stringify({ type: "events", events })}\n\n`);
          } else {
            res.write(`: keep-alive\n\n`);
          }
        })
        .catch(() => {
          // Best-effort — a failed poll just means the client waits for the
          // next tick or eventually reconnects; Postgres remains authoritative.
        });
    }, deps.pollIntervalMs ?? 2000);

    req.on("close", () => clearInterval(interval));
  };
}
