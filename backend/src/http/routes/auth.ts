import type { Request, Response } from "express";
import type { Pool } from "pg";
import { saveAuthSession, getAuthSession, getAuthSessionStatus, deleteAuthSession } from "../../db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../../whop/oauthClient.js";
import { globalRedactor } from "../../lib/redact.js";
import { logger } from "../../lib/logger.js";

export interface AuthRoutesDeps {
  pool: Pool;
  oauthClient: WhopOAuthClient;
  refreshTokenEncryptionKey: string;
}

interface EstablishSessionBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * POST /api/auth/session — the frontend calls this once, right after its
 * existing PKCE code-exchange succeeds, to hand the resulting tokens off
 * for server-side storage (§04 of the architecture proposal). The frontend
 * never writes these to localStorage; this is the only place they're
 * persisted, encrypted at rest.
 *
 * This is the one route reachable before any operator identity exists —
 * every other sensitive route requires one already be established. The
 * identity itself is never taken from a client-supplied claim (there is no
 * id_token in this request at all): the submitted access_token is verified
 * against Whop's userinfo endpoint first, and only that verified `sub` is
 * ever persisted as the operator identity. Once an operator exists, a
 * session-establishment attempt verified as a *different* Whop user is
 * rejected outright — the singleton session can never be silently taken
 * over.
 */
export function createEstablishSessionHandler(deps: AuthRoutesDeps) {
  return async function establishSessionHandler(req: Request, res: Response): Promise<void> {
    const body = req.body as EstablishSessionBody;
    if (!body?.access_token || !body?.refresh_token || !body?.expires_in) {
      res.status(400).json({
        error: { message: "Missing access_token, refresh_token, or expires_in.", type: "invalid_request" },
      });
      return;
    }

    globalRedactor.register(body.access_token);
    globalRedactor.register(body.refresh_token);

    let verified;
    try {
      verified = await deps.oauthClient.verifyAccessToken(body.access_token);
    } catch (err) {
      if (err instanceof WhopIdentityError) {
        res.status(401).json({
          error: { message: "Could not verify the supplied Whop access token.", type: "invalid_token" },
        });
        return;
      }
      throw err;
    }

    const existingOperator = await getAuthSessionStatus(deps.pool);
    if (existingOperator && existingOperator.whopUserId !== verified.sub) {
      res.status(403).json({
        error: {
          message: "A different Whop account already owns this deployment's operator session.",
          type: "forbidden_operator",
        },
      });
      return;
    }

    await saveAuthSession(
      deps.pool,
      {
        whopUserId: verified.sub,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000),
      },
      deps.refreshTokenEncryptionKey,
    );

    res.status(200).json({ ok: true });
  };
}

/** GET /api/auth/status — never returns a token value, only connection state. */
export function createAuthStatusHandler(deps: AuthRoutesDeps) {
  return async function authStatusHandler(_req: Request, res: Response): Promise<void> {
    const status = await getAuthSessionStatus(deps.pool);
    if (!status) {
      res.status(200).json({ connected: false, status: null, whopUserId: null });
      return;
    }
    res.status(200).json({
      connected: status.status === "active",
      status: status.status,
      whopUserId: status.whopUserId,
    });
  };
}

/** POST /api/auth/disconnect — revokes with Whop (best-effort) then always clears the local session. */
export function createDisconnectHandler(deps: AuthRoutesDeps) {
  return async function disconnectHandler(_req: Request, res: Response): Promise<void> {
    const session = await getAuthSession(deps.pool, deps.refreshTokenEncryptionKey).catch(() => null);
    if (session) {
      try {
        await deps.oauthClient.revokeRefreshToken(session.refreshToken);
      } catch (err) {
        logger.warn("Whop refresh-token revoke failed during disconnect (clearing local session anyway)", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await deleteAuthSession(deps.pool);
    res.status(200).json({ ok: true });
  };
}
