import { describe, it, expect, vi } from "vitest";
import type { Request, NextFunction } from "express";
import { requireKnoveraAuth, type KnoveraAuthedRequest } from "../src/http/middleware/knoveraAuth.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { makeResponse } from "./helpers/httpMocks.js";

const SECRET = "test-middleware-secret";

describe("requireKnoveraAuth middleware", () => {
  it("responds 401 and never calls next() when no Authorization header is present", async () => {
    const middleware = requireKnoveraAuth({ authSecret: SECRET });
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    middleware({ headers: {} } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "missing_authorization" } });
    expect(next).not.toHaveBeenCalled();
  });

  it("E: a valid token calls next() and attaches the operator subject, never calling Whop", () => {
    const middleware = requireKnoveraAuth({ authSecret: SECRET });
    const token = issueKnoveraToken(SECRET);
    const { res } = makeResponse();
    const next = vi.fn() as NextFunction;
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as KnoveraAuthedRequest).knoveraOperator).toBe("knovera-operator");
  });

  it("F: an expired token is rejected with 401 knovera_unauthenticated, never a generic 500", () => {
    const middleware = requireKnoveraAuth({ authSecret: SECRET });
    const expiredToken = issueKnoveraToken(SECRET, -1);
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    middleware({ headers: { authorization: `Bearer ${expiredToken}` } } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "knovera_unauthenticated" } });
    expect(next).not.toHaveBeenCalled();
  });

  it("G: a tampered/wrong-secret token is rejected", () => {
    const middleware = requireKnoveraAuth({ authSecret: SECRET });
    const tokenFromWrongSecret = issueKnoveraToken("a-different-secret");
    const { res, statusCode } = makeResponse();
    const next = vi.fn() as NextFunction;

    middleware({ headers: { authorization: `Bearer ${tokenFromWrongSecret}` } } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header (not the Bearer scheme)", () => {
    const middleware = requireKnoveraAuth({ authSecret: SECRET });
    const { res, statusCode } = makeResponse();
    const next = vi.fn() as NextFunction;

    middleware({ headers: { authorization: "Basic dXNlcjpwYXNz" } } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
