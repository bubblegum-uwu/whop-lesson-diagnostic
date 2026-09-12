import type { Request, Response } from "express";
import type { Pool } from "pg";
import { verifyDiscordInteractionSignature } from "../../discord/discordInteractionsVerify.js";
import { getKnoveraIdentityForDiscordUser } from "../../db/discordUserLinksRepo.js";
import { issueDiscordLinkToken } from "../../db/discordLinkTokensRepo.js";
import { ensureDiscordKnowledgeProject } from "../../db/defaultProjectInboxesRepo.js";
import { createSourceCollection } from "../../db/sourceCollectionsRepo.js";
import { createDiscordCaptureJob } from "../../db/discordCaptureJobsRepo.js";
import { isSupportedVideoFilename } from "../../lib/discordUrl.js";
import { logger } from "../../lib/logger.js";

export interface RawBodyRequest extends Request {
  /** Populated by app.ts's express.json({ verify }) — the exact bytes Discord signed, captured before JSON parsing (spec section 14: signature verification must use the raw body, never a re-serialized one). */
  rawBody?: Buffer;
}

export interface DiscordInteractionsRouteDeps {
  pool: Pool;
  /** Discord's raw hex-encoded Ed25519 application public key (Developer Portal → General Information). Required for this endpoint to do anything but reject every request. */
  discordPublicKey?: string;
  /** Where the account-linking page lives — this service's own frontend origin (same value used elsewhere, e.g. discordConnections.ts's allowedOrigin). */
  allowedOrigin: string;
}

// Discord Interactions API — verified against current documentation
// before implementation (spec section 1/17): InteractionType.PING = 1,
// APPLICATION_COMMAND = 2; ApplicationCommandType.MESSAGE = 3;
// InteractionResponseType.PONG = 1, CHANNEL_MESSAGE_WITH_SOURCE = 4;
// MESSAGE_FLAGS.EPHEMERAL = 1 << 6 = 64; ApplicationIntegrationType
// USER_INSTALL = 1 (the key discord uses in `authorizing_integration_owners`).
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const APPLICATION_COMMAND_TYPE_MESSAGE = 3;
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const MESSAGE_FLAG_EPHEMERAL = 1 << 6;
const USER_INSTALL_INTEGRATION_KEY = "1";

export const SAVE_TO_KNOVERA_COMMAND_NAME = "Save to Knovera";

interface DiscordAttachmentPayload {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  url: string;
}
interface DiscordMessagePayload {
  id: string;
  attachments?: DiscordAttachmentPayload[];
}
interface DiscordInteraction {
  id: string;
  type: number;
  guild_id?: string;
  channel?: { id: string; name?: string; type?: number };
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  authorizing_integration_owners?: Record<string, string>;
  data?: {
    type?: number;
    name?: string;
    target_id?: string;
    resolved?: { messages?: Record<string, DiscordMessagePayload> };
  };
}

function ephemeralMessage(content: string) {
  return { type: RESPONSE_TYPE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: MESSAGE_FLAG_EPHEMERAL } };
}

/**
 * POST /api/discord/interactions — PUBLIC (Discord calls this directly;
 * no Knovera session is possible here — spec section 14). The one and
 * only capture boundary: everything this handler does happens because
 * the user explicitly invoked "Save to Knovera" on one specific message.
 * It never fetches message history, never enumerates channels, never
 * touches any message other than the one Discord resolved for THIS
 * interaction (spec section 3/4).
 */
export function createDiscordInteractionsHandler(deps: DiscordInteractionsRouteDeps) {
  return async function discordInteractionsHandler(req: Request, res: Response): Promise<void> {
    const rawBody = (req as RawBodyRequest).rawBody;
    const signature = req.header("X-Signature-Ed25519");
    const timestamp = req.header("X-Signature-Timestamp");

    if (!deps.discordPublicKey || !rawBody || !signature || !timestamp || !verifyDiscordInteractionSignature(rawBody, signature, timestamp, deps.discordPublicKey)) {
      res.status(401).send("invalid request signature");
      return;
    }

    const interaction = req.body as DiscordInteraction;

    if (interaction.type === INTERACTION_TYPE_PING) {
      res.status(200).json({ type: RESPONSE_TYPE_PONG });
      return;
    }

    if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND || interaction.data?.type !== APPLICATION_COMMAND_TYPE_MESSAGE) {
      // Not a command this integration handles — acknowledge harmlessly
      // rather than erroring (a future second command, or a stale
      // registration, should never surface as a broken interaction).
      res.status(200).json(ephemeralMessage("This command is not supported."));
      return;
    }

    // Spec section 11 — the AUTHORIZING owner (who installed this
    // USER_INSTALL app to their own account) is the identity this capture
    // is ever attributed to; the invoking user (member.user / user, i.e.
    // whoever is physically present wherever the command was invoked)
    // MUST be the same person for a personal user-install app. Any
    // mismatch means something is wrong (a forged/malformed payload, or
    // an install-context this integration was never designed for) — fail
    // closed rather than guess which identity to trust.
    const authorizingDiscordUserId = interaction.authorizing_integration_owners?.[USER_INSTALL_INTEGRATION_KEY];
    const invokingDiscordUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!authorizingDiscordUserId || !invokingDiscordUserId || authorizingDiscordUserId !== invokingDiscordUserId) {
      logger.error("Discord interaction rejected — authorizing/invoking user mismatch or missing", {
        hasAuthorizing: !!authorizingDiscordUserId,
        hasInvoking: !!invokingDiscordUserId,
      });
      res.status(200).json(ephemeralMessage("Could not verify your Discord identity for this action. Please try again."));
      return;
    }
    const discordUserId = authorizingDiscordUserId;

    const link = await getKnoveraIdentityForDiscordUser(deps.pool, discordUserId);
    if (!link) {
      const token = await issueDiscordLinkToken(deps.pool, discordUserId);
      const linkUrl = `${deps.allowedOrigin}/#/link-discord?token=${encodeURIComponent(token)}`;
      res.status(200).json(ephemeralMessage(`Your Discord account is not linked to Knovera yet.\n\nLink to Knovera: ${linkUrl}\n\nThen invoke "${SAVE_TO_KNOVERA_COMMAND_NAME}" again on this message.`));
      return;
    }
    const knoveraIdentity = link.knoveraIdentity;

    // No MESSAGE_CONTENT privileged intent is needed for any of this — this
    // integration never runs a bot Gateway connection at all (no login, no
    // WebSocket, no intents to declare in the first place). Discord's
    // Interactions API delivers `data.resolved.messages` for the exact
    // message a MESSAGE-type command was invoked on as part of the signed
    // interaction payload itself, and Discord explicitly exempts that one
    // message from the normal Message Content Intent restriction (it is
    // the whole point of a message context-menu command) — see the
    // "Message Content Intent for Message Commands" carve-out in Discord's
    // own interactions documentation. This is why Phase 4K-B (revised)
    // never carries forward PR #30's MESSAGE_CONTENT readiness checks.
    const targetMessageId = interaction.data.target_id;
    const message = targetMessageId ? interaction.data.resolved?.messages?.[targetMessageId] : undefined;
    if (!message) {
      logger.error("Discord interaction missing resolved target message", { interactionId: interaction.id });
      res.status(200).json(ephemeralMessage("Could not read the target message. Please try again."));
      return;
    }

    const supportedAttachments = (message.attachments ?? []).filter((a) => isSupportedVideoFilename(a.filename));
    if (supportedAttachments.length === 0) {
      res.status(200).json(ephemeralMessage("No supported video attachment was found in this message."));
      return;
    }

    const project = await ensureDiscordKnowledgeProject(deps.pool, knoveraIdentity);

    const channelId = interaction.channel?.id ?? interaction.channel_id ?? message.id;
    const guildId = interaction.guild_id ?? null;
    const channelLabel = guildId ? (interaction.channel?.name ? `#${interaction.channel.name}` : `#${channelId}`) : "Direct Message";
    // Stable channel identity (spec section 28) — guild_id + channel_id
    // for a guild channel (a channel id alone is only unique WITHIN a
    // guild), channel_id alone for a DM/GDM (which has no guild).
    const collectionExternalId = guildId ? `${guildId}:${channelId}` : channelId;
    const { collection } = await createSourceCollection(deps.pool, {
      projectId: project.id,
      provider: "DISCORD",
      externalId: collectionExternalId,
      title: channelLabel,
      sourceUrl: guildId ? `https://discord.com/channels/${guildId}/${channelId}` : `https://discord.com/channels/@me/${channelId}`,
    });

    for (const attachment of supportedAttachments) {
      await createDiscordCaptureJob(deps.pool, {
        ownerIdentity: knoveraIdentity,
        discordUserId,
        projectId: project.id,
        collectionId: collection.id,
        interactionId: interaction.id,
        messageId: message.id,
        channelId,
        guildId,
        channelLabel,
        attachmentId: attachment.id,
        attachmentUrl: attachment.url,
        filename: attachment.filename,
        contentType: attachment.content_type ?? null,
        byteSize: attachment.size ?? null,
      });
    }

    // Spec section 27 — truthful, in-progress phrasing only; durable
    // capture has not happened yet at this point (see worker/discordCaptureLoop.ts).
    const count = supportedAttachments.length;
    res.status(200).json(ephemeralMessage(`Saving ${count} video${count === 1 ? "" : "s"} to Discord Knowledge…`));
  };
}
