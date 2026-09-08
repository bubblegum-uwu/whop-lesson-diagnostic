import type { Request, Response } from "express";
import { verifyPassword } from "../../lib/passwordHash.js";
import { issueKnoveraToken, verifyKnoveraToken, KNOVERA_TOKEN_TTL_SECONDS } from "../../lib/knoveraToken.js";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import type { KnoveraAuthConfig } from "../../config.js";

export interface KnoveraAuthRoutesDeps {
  knoveraAuth: KnoveraAuthConfig;
}

interface LoginBody {
  email?: string;
  password?: string;
}

/** Case-insensitive, trimmed — matches how a person actually types an email, never a raw byte-for-byte comparison. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * POST /api/knovera-auth/login — the ONLY way to obtain a Knovera session
 * token. Compares against the one configured operator identity
 * (KNOVERA_LOGIN_EMAIL / KNOVERA_PASSWORD_HASH) — there is no user table,
 * no registration (see the Phase 4D PR description's "single-user, no user
 * database" scope). Never reveals which of email/password was wrong: both
 * failure modes return the identical 401 below.
 */
export function createKnoveraLoginHandler(deps: KnoveraAuthRoutesDeps) {
  return async function knoveraLoginHandler(req: Request, res: Response): Promise<void> {
    const body = req.body as LoginBody;
    if (!body?.email || !body?.password) {
      res.status(400).json({ error: { message: "Missing email or password.", type: "invalid_request" } });
      return;
    }

    const emailMatches = normalizeEmail(body.email) === normalizeEmail(deps.knoveraAuth.loginEmail);
    // Always run verifyPassword, even on a known email mismatch, so a
    // response-time difference can't leak which check failed (verifyPassword
    // itself is already timing-safe on the hash comparison; this keeps the
    // two failure paths doing the same amount of work).
    const passwordMatches = await verifyPassword(body.password, deps.knoveraAuth.passwordHash);

    if (!emailMatches || !passwordMatches) {
      res.status(401).json({ error: { message: "Invalid email or password.", type: "invalid_credentials" } });
      return;
    }

    const token = issueKnoveraToken(deps.knoveraAuth.authSecret);
    res.status(200).json({ token, expiresIn: KNOVERA_TOKEN_TTL_SECONDS });
  };
}

/** GET /api/knovera-auth/me — requires a valid token (see requireKnoveraAuth); reachable only after that middleware has already verified it, so a 200 here always means "authenticated." */
export function createKnoveraMeHandler(deps: KnoveraAuthRoutesDeps) {
  return function knoveraMeHandler(_req: Request, res: Response): void {
    res.status(200).json({ authenticated: true, email: deps.knoveraAuth.loginEmail });
  };
}

/**
 * POST /api/knovera-auth/logout — this is a stateless signed-token
 * architecture (see knoveraToken.ts): there is no server-side session store
 * to revoke from, so this endpoint does not and cannot invalidate the token
 * itself before its natural expiry. It exists to (a) give the frontend a
 * clean, explicit "log out" call to make and (b) fail deterministically if
 * called without a currently-valid token, exactly like every other
 * Knovera-authed route. The frontend's own token discard is what actually
 * ends the session for that browser.
 */
export function createKnoveraLogoutHandler(deps: KnoveraAuthRoutesDeps) {
  return function knoveraLogoutHandler(req: Request, res: Response): void {
    let token: string;
    try {
      token = requireBearerToken(req.headers.authorization);
    } catch (err) {
      if (err instanceof MissingAuthorizationError) {
        res.status(401).json({ error: { message: err.message, type: "missing_authorization" } });
        return;
      }
      throw err;
    }
    if (!verifyKnoveraToken(token, deps.knoveraAuth.authSecret)) {
      res.status(401).json({
        error: { message: "Invalid or expired Knovera session — please log in again.", type: "knovera_unauthenticated" },
      });
      return;
    }
    res.status(200).json({ ok: true });
  };
}
