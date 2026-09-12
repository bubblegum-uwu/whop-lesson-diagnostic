/**
 * The Discord application id this Knovera deployment's "Save to Knovera"
 * USER_INSTALL app is registered under — public configuration (Discord
 * application ids are not secrets; see backend/src/config.ts's identical
 * doc comment on discordApplicationId), set at build time via
 * VITE_DISCORD_APPLICATION_ID. Returns null when unconfigured so the
 * install button can be hidden/disabled instead of linking to a broken
 * install flow.
 */
export function getDiscordApplicationId(): string | null {
  const id = import.meta.env.VITE_DISCORD_APPLICATION_ID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The USER_INSTALL authorize link (spec: never a guild/bot install —
 * `integration_type=1` is Discord's USER_INSTALL integration type, the
 * same enum value the backend's interaction handler checks against in
 * `authorizing_integration_owners`). Verify this exact query shape
 * against current Discord documentation before relying on it in
 * production — Discord's install-link format has changed before.
 */
export function buildDiscordInstallUrl(applicationId: string): string {
  const params = new URLSearchParams({ client_id: applicationId, integration_type: "1", scope: "applications.commands" });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
