import type { Response } from "express";
import { vi } from "vitest";

export interface RecordedResponse {
  res: Response;
  statusCode(): number;
  body(): unknown;
  /** Set only by a handler calling res.redirect(...) — undefined for a plain status()/json() response. */
  redirectedTo(): string | undefined;
}

/** A minimal fake Express Response that records status()/json()/redirect() calls — no server needed. */
export function makeResponse(): RecordedResponse {
  let recordedStatus = 200;
  let recordedBody: unknown;
  let recordedRedirect: string | undefined;

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
    // Express's res.redirect supports (url) and (status, url) — both used across this codebase.
    redirect: vi.fn((statusOrUrl: number | string, maybeUrl?: string) => {
      if (typeof statusOrUrl === "number") {
        recordedStatus = statusOrUrl;
        recordedRedirect = maybeUrl;
      } else {
        recordedRedirect = statusOrUrl;
      }
      return res;
    }),
  } as unknown as Response;

  return { res, statusCode: () => recordedStatus, body: () => recordedBody, redirectedTo: () => recordedRedirect };
}
