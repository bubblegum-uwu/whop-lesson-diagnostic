import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { KnoveraAuthedRequest } from "../middleware/knoveraAuth.js";
import { consumeDiscordLinkToken } from "../../db/discordLinkTokensRepo.js";
import { linkDiscordUserToIdentity, listDiscordUserLinksForIdentity, unlinkAllDiscordUsersForIdentity } from "../../db/discordUserLinksRepo.js";
import { ensureDiscordKnowledgeProject } from "../../db/defaultProjectInboxesRepo.js";

export interface DiscordAccountLinkRouteDeps {
  pool: Pool;
}

function identityOf(req: Request): string {
  return (req as KnoveraAuthedRequest).knoveraOperator!;
}

interface ConsumeLinkBody {
  token?: unknown;
}

/**
 * POST /api/discord/link — Knovera-authed (spec section 12: "normal
 * Knovera login required" before the token is consumed). The browser
 * supplies only the opaque, single-use token it was handed by the
 * ephemeral Discord interaction response — never a Discord user id
 * directly (spec section 13: "do not trust a Discord user id supplied
 * directly by the browser"). consumeDiscordLinkToken is the one place
 * that maps token -> discordUserId, atomically and single-use.
 */
export function createConsumeDiscordLinkHandler(deps: DiscordAccountLinkRouteDeps) {
  return async function consumeDiscordLinkHandler(req: Request, res: Response): Promise<void> {
    const body = req.body as ConsumeLinkBody;
    if (typeof body?.token !== "string" || body.token.length === 0) {
      res.status(400).json({ error: { message: "token is required.", type: "invalid_request" } });
      return;
    }

    const discordUserId = await consumeDiscordLinkToken(deps.pool, body.token);
    if (!discordUserId) {
      res.status(400).json({ error: { message: "This link is invalid, expired, or has already been used. Please invoke \"Save to Knovera\" again to get a fresh link.", type: "invalid_link_token" } });
      return;
    }

    const identity = identityOf(req);
    await linkDiscordUserToIdentity(deps.pool, discordUserId, identity);
    // Pre-warm Discord Knowledge right away so the very first capture
    // after linking has zero extra latency — harmless if it already
    // exists (idempotent).
    await ensureDiscordKnowledgeProject(deps.pool, identity);

    res.status(200).json({ ok: true });
  };
}

/** GET /api/discord/link — Sources page status (spec section 54). */
export function createGetDiscordLinkStatusHandler(deps: DiscordAccountLinkRouteDeps) {
  return async function getDiscordLinkStatusHandler(req: Request, res: Response): Promise<void> {
    const links = await listDiscordUserLinksForIdentity(deps.pool, identityOf(req));
    res.status(200).json({ linked: links.length > 0, discordUserIds: links.map((l) => l.discordUserId) });
  };
}

/** DELETE /api/discord/link — spec section 54: affects future captures only; never touches previously-captured content_assets/project_sources/collections. */
export function createUnlinkDiscordHandler(deps: DiscordAccountLinkRouteDeps) {
  return async function unlinkDiscordHandler(req: Request, res: Response): Promise<void> {
    await unlinkAllDiscordUsersForIdentity(deps.pool, identityOf(req));
    res.status(200).json({ ok: true });
  };
}
