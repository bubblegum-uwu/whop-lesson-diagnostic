import type { Response } from "express";
import { vi } from "vitest";

export interface RecordedResponse {
  res: Response;
  statusCode(): number;
  body(): unknown;
}

/** A minimal fake Express Response that records status()/json() calls — no server needed. */
export function makeResponse(): RecordedResponse {
  let recordedStatus = 200;
  let recordedBody: unknown;

  const res = {
    status: vi.fn((code: number) => {
      recordedStatus = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      recordedBody = body;
      return res;
    }),
    end: vi.fn(() => res),
  } as unknown as Response;

  return { res, statusCode: () => recordedStatus, body: () => recordedBody };
}
