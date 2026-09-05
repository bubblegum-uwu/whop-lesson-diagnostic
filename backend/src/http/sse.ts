import type { Response } from "express";

/**
 * Minimal Server-Sent-Events helper. All events are sent as plain `data:`
 * frames carrying a JSON payload with a `type` discriminator, so the
 * frontend can distinguish stage/result/error without relying on named SSE
 * event types (simpler to parse with a plain fetch() ReadableStream reader).
 */

export type SseEvent =
  | { type: "stage"; stage: string; label: string }
  | { type: "result"; payload: unknown }
  | { type: "error"; message: string; stage?: string };

export function startSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

export function sendSseEvent(res: Response, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
