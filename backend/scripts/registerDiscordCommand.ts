/**
 * Live-validation Fix 5 — idempotent registration of the global "Save to
 * Knovera" MESSAGE context-menu command (Phase 4K-B revised). This is a
 * one-time/rare offline setup step, never run by the running server
 * itself: the interactions endpoint (src/http/routes/discordInteractions.ts)
 * needs no bot token at all — it authenticates every request via Ed25519
 * signature verification against DISCORD_PUBLIC_KEY (see
 * discord/discordInteractionsVerify.ts). DISCORD_BOT_TOKEN is used ONLY
 * here, ONLY at registration time, and is NEVER printed/logged below —
 * only Discord's own (token-free) JSON error bodies and HTTP status codes
 * ever surface in this script's output.
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=<application id> DISCORD_BOT_TOKEN=<bot token> \
 *     npm run discord:register-command
 *
 * Where to find these (Discord Developer Portal → your application):
 *   DISCORD_APPLICATION_ID — General Information → Application ID (not a secret)
 *   DISCORD_BOT_TOKEN      — Bot → Reset Token (a SECRET — never commit it,
 *                            never paste it into chat/logs)
 *
 * What this registers — a global MESSAGE command, USER_INSTALL only:
 *   name: "Save to Knovera", type: 3 (MESSAGE)
 *   integration_types: [1]     (USER_INSTALL only — never GUILD_INSTALL/0)
 *   contexts: [0, 1, 2]        (guild channel, bot DM, private/group DM)
 * Verify these exact numeric values against Discord's current
 * documentation before relying on this script in production — Discord's
 * enum values are a hard external dependency, not something to guess.
 *
 * Idempotent: lists this application's existing GLOBAL commands, finds one
 * already named "Save to Knovera" of type MESSAGE, and PATCHes ONLY that
 * one command if its definition actually differs from the desired one —
 * this never touches any other command the application may have
 * registered, and deliberately never uses Discord's bulk-overwrite
 * endpoint (PUT .../commands), which would silently delete every other
 * global command. Creates the command fresh only if none exists yet. Safe
 * to re-run at any time, including with no changes pending (no-op).
 */

const COMMAND_NAME = "Save to Knovera";
const APPLICATION_COMMAND_TYPE_MESSAGE = 3;
const INTEGRATION_TYPE_USER_INSTALL = 1;
const INTERACTION_CONTEXT_GUILD = 0;
const INTERACTION_CONTEXT_BOT_DM = 1;
const INTERACTION_CONTEXT_PRIVATE_CHANNEL = 2;

const DISCORD_API_BASE = "https://discord.com/api/v10";

interface DiscordApplicationCommand {
  id: string;
  name: string;
  type: number;
  description?: string;
  integration_types?: number[];
  contexts?: number[] | null;
}

interface DesiredCommandDefinition {
  name: string;
  type: number;
  description: string;
  integration_types: number[];
  contexts: number[];
}

function desiredCommandDefinition(): DesiredCommandDefinition {
  return {
    name: COMMAND_NAME,
    type: APPLICATION_COMMAND_TYPE_MESSAGE,
    // MESSAGE/USER-type commands have no slash-command-style description
    // shown to the user, but Discord's API requires the field present —
    // an explicit empty string, never omitted.
    description: "",
    integration_types: [INTEGRATION_TYPE_USER_INSTALL],
    contexts: [INTERACTION_CONTEXT_GUILD, INTERACTION_CONTEXT_BOT_DM, INTERACTION_CONTEXT_PRIVATE_CHANNEL],
  };
}

function sameNumberSet(a: number[] | null | undefined, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, i) => value === sortedB[i]);
}

function matchesDesiredDefinition(existing: DiscordApplicationCommand): boolean {
  const desired = desiredCommandDefinition();
  return (
    existing.name === desired.name &&
    existing.type === desired.type &&
    (existing.description ?? "") === desired.description &&
    sameNumberSet(existing.integration_types, desired.integration_types) &&
    sameNumberSet(existing.contexts, desired.contexts)
  );
}

async function discordRequest(path: string, botToken: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function readJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Never includes the bot token or Authorization header — only the HTTP status and Discord's own JSON error body. */
function describeError(res: Response, body: unknown): string {
  return `Discord API request failed (HTTP ${res.status} ${res.statusText}): ${JSON.stringify(body)}`;
}

async function main(): Promise<void> {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!applicationId) throw new Error("Missing required environment variable: DISCORD_APPLICATION_ID");
  if (!botToken) throw new Error("Missing required environment variable: DISCORD_BOT_TOKEN");

  console.log(`Listing existing global commands for application ${applicationId}...`);
  const listRes = await discordRequest(`/applications/${applicationId}/commands`, botToken);
  const listBody = await readJsonSafely(listRes);
  if (!listRes.ok) throw new Error(describeError(listRes, listBody));
  const existingCommands = Array.isArray(listBody) ? (listBody as DiscordApplicationCommand[]) : [];

  const matches = existingCommands.filter((c) => c.name === COMMAND_NAME && c.type === APPLICATION_COMMAND_TYPE_MESSAGE);
  if (matches.length > 1) {
    console.warn(
      `WARNING: found ${matches.length} existing global commands named "${COMMAND_NAME}" of type MESSAGE ` +
        `(ids: ${matches.map((c) => c.id).join(", ")}). This should never happen from running this script alone. ` +
        `Only the first (id ${matches[0].id}) will be updated — review and manually remove the extras in the ` +
        `Discord Developer Portal if this is unexpected. Never auto-deleted by this script.`,
    );
  }
  const existing = matches[0];

  if (!existing) {
    console.log(`No existing "${COMMAND_NAME}" command found — creating it.`);
    const createRes = await discordRequest(`/applications/${applicationId}/commands`, botToken, {
      method: "POST",
      body: JSON.stringify(desiredCommandDefinition()),
    });
    const createBody = await readJsonSafely(createRes);
    if (!createRes.ok) throw new Error(describeError(createRes, createBody));
    console.log(`Created global command "${COMMAND_NAME}" (id ${(createBody as DiscordApplicationCommand).id}).`);
    return;
  }

  if (matchesDesiredDefinition(existing)) {
    console.log(`Existing "${COMMAND_NAME}" command (id ${existing.id}) already matches the desired definition — nothing to do.`);
    return;
  }

  console.log(`Existing "${COMMAND_NAME}" command (id ${existing.id}) differs from the desired definition — updating it in place (never a bulk overwrite).`);
  const patchRes = await discordRequest(`/applications/${applicationId}/commands/${existing.id}`, botToken, {
    method: "PATCH",
    body: JSON.stringify(desiredCommandDefinition()),
  });
  const patchBody = await readJsonSafely(patchRes);
  if (!patchRes.ok) throw new Error(describeError(patchRes, patchBody));
  console.log(`Updated global command "${COMMAND_NAME}" (id ${existing.id}).`);
}

main().catch((err) => {
  console.error("Failed to register Discord command:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
