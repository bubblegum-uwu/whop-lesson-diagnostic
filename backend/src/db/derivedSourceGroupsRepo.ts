import type { Pool } from "pg";

/**
 * Phase 4L taxonomy correction — grouping for `project_sources` rows that
 * have NO persisted `source_collections` membership (`collection_id IS
 * NULL`). Before this phase, every such row rendered as a single flat
 * "Uncollected Sources / À-la-carte" bucket regardless of how it was
 * actually acquired — wrong for a YouTube video discovered by scanning a
 * Discord channel (Phase 4K-C's channel-scan import never sets
 * `collection_id`; see http/routes/projectSources.ts's
 * createDiscordImportYouTubeSourcesHandler), which must instead render
 * under its Discord channel's identity (`YOUTUBE · CHANNEL` / `Discord ·
 * #channel-name`), matching the SAME "channel" concept a real
 * `source_collections` YouTube-channel row represents.
 *
 * This module is the ONE place that classifies such a row into a group —
 * both the group-summary list (listDerivedGroupsForProject) and the
 * member-id resolver (listDerivedGroupMemberSourceIds, used by Analyze
 * Collection and Synthesis Set collection-selection) build off the exact
 * same classifyDerivedGroups() query + classification rule, so the Sources
 * page, "Analyze Collection", and Synthesis Set group-selection can never
 * disagree about what belongs to a group.
 *
 * Precedence per source (deterministic, never re-evaluated live — a
 * classification is only ever computed at read time from durable data):
 *   1. Earliest DISCORD_CHANNEL origin (created_at ASC, id ASC — stable
 *      under re-scans, never flips which channel "wins" for a video posted
 *      in multiple channels) → YOUTUBE · CHANNEL / Discord · #channel.
 *   2. A MANUAL origin → YOUTUBE · À-LA-CARTE. Never reached for a source
 *      that also has a DISCORD_CHANNEL origin (case 1 always wins) — this
 *      is what keeps a Discord-discovered video that was ALSO manually
 *      re-added from ever duplicating into a second card.
 *   3. Neither → Unclassified (rare: a legacy pre-Phase-4K-C row, or a
 *      Discord source added via the raw-CDN-URL-paste path, which records
 *      no origin/channel data at all — see createAddDiscordSourceHandler).
 *
 * No new schema: everything here is derived from `project_sources` +
 * `project_source_origins`, which already exist.
 */

export type DerivedGroupSourceType = "CHANNEL" | "A_LA_CARTE" | "UNCLASSIFIED";
export type DerivedGroupOriginProvider = "DISCORD" | "MANUAL" | null;

export interface DerivedGroupClassification {
  sourceId: number;
  provider: "YOUTUBE" | "DISCORD";
  groupKey: string;
  sourceType: DerivedGroupSourceType;
  originProvider: DerivedGroupOriginProvider;
  /** The Discord channel id for a CHANNEL group, else null. Group identity uses this — never the display name (which can be null/renamed). */
  originContainerId: string | null;
  /** Best-known display label for the group's origin/container — "#channel-name" when known, else a safe fallback to the raw channel id. Never used as the group's identity, only its title. */
  originDisplayLabel: string | null;
  createdAt: Date;
}

interface ClassifyDbRow {
  id: string;
  provider: string;
  discord_guild_id: string | null;
  discord_channel_id: string | null;
  discord_channel_name: string | null;
  has_manual_origin: boolean;
  created_at: Date;
}

export const UNCLASSIFIED_GROUP_KEY = "derived:unclassified";
export const YOUTUBE_ALA_CARTE_GROUP_KEY = "derived:youtube-ala-carte";

/** Same externalId shape Discord-native collections already use (see discordInteractions.ts) — `guildId:channelId`, or bare `channelId` for a guild-less (DM) capture — so a derived YouTube-via-Discord-channel group's container id lines up with a real Discord collection's container id for the same channel. */
function discordChannelContainerId(guildId: string | null, channelId: string): string {
  return guildId ? `${guildId}:${channelId}` : channelId;
}

function classifyRow(row: ClassifyDbRow): DerivedGroupClassification {
  const sourceId = Number(row.id);
  const provider = row.provider as "YOUTUBE" | "DISCORD";
  const createdAt = row.created_at;

  if (provider === "YOUTUBE" && row.discord_channel_id) {
    const containerId = discordChannelContainerId(row.discord_guild_id, row.discord_channel_id);
    return {
      sourceId,
      provider,
      groupKey: `derived:youtube-discord-channel:${containerId}`,
      sourceType: "CHANNEL",
      originProvider: "DISCORD",
      originContainerId: row.discord_channel_id,
      originDisplayLabel: row.discord_channel_name ? `#${row.discord_channel_name}` : `channel ${row.discord_channel_id}`,
      createdAt,
    };
  }

  if (provider === "YOUTUBE" && row.has_manual_origin) {
    return {
      sourceId,
      provider,
      groupKey: YOUTUBE_ALA_CARTE_GROUP_KEY,
      sourceType: "A_LA_CARTE",
      originProvider: "MANUAL",
      originContainerId: null,
      originDisplayLabel: null,
      createdAt,
    };
  }

  // DISCORD-provider rows never reach this classifier with a collectionId —
  // the right-click "Save to Knovera" capture always creates/reuses a real
  // source_collections row first (see discordInteractions.ts), so the only
  // way a DISCORD row has collection_id IS NULL is the raw-CDN-URL-paste
  // add path, which records no origin at all. Per spec, this must NEVER be
  // classified as a Discord À-la-carte group — it falls through to
  // Unclassified exactly like a YOUTUBE row with no origin data.
  return {
    sourceId,
    provider,
    groupKey: UNCLASSIFIED_GROUP_KEY,
    sourceType: "UNCLASSIFIED",
    originProvider: null,
    originContainerId: null,
    originDisplayLabel: null,
    createdAt,
  };
}

/**
 * The single shared query + classification pass. Batched (one round trip),
 * never N+1 per source. Only ever considers `collection_id IS NULL` rows —
 * a source with a persisted collection is already grouped by that
 * collection and must never also appear in a derived group (no
 * duplication across primary groups).
 */
export async function classifyDerivedGroups(pool: Pool, projectId: number): Promise<DerivedGroupClassification[]> {
  const result = await pool.query<ClassifyDbRow>(
    `SELECT
       ps.id,
       ps.provider,
       dc.discord_guild_id,
       dc.discord_channel_id,
       dc.discord_channel_name,
       (m.id IS NOT NULL) AS has_manual_origin,
       ps.created_at
     FROM project_sources ps
     LEFT JOIN LATERAL (
       SELECT discord_guild_id, discord_channel_id, discord_channel_name
       FROM project_source_origins o
       WHERE o.project_source_id = ps.id AND o.origin_type = 'DISCORD_CHANNEL'
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT 1
     ) dc ON true
     LEFT JOIN project_source_origins m ON m.project_source_id = ps.id AND m.origin_type = 'MANUAL'
     WHERE ps.project_id = $1 AND ps.collection_id IS NULL
     ORDER BY ps.created_at ASC`,
    [projectId],
  );
  return result.rows.map(classifyRow);
}

export interface DerivedGroupDescriptor {
  groupKey: string;
  provider: "YOUTUBE" | "DISCORD" | null;
  sourceType: DerivedGroupSourceType;
  originProvider: DerivedGroupOriginProvider;
  originContainerId: string | null;
  /** "YOUTUBE · CHANNEL" style title is composed by the caller from provider+sourceType; this is only the origin/container half — e.g. "Discord · #scarface-alerts", "Manual YouTube", or null for Unclassified. */
  title: string;
  memberSourceIds: number[];
}

function titleFor(sourceType: DerivedGroupSourceType, originDisplayLabel: string | null): string {
  if (sourceType === "CHANNEL") return `Discord · ${originDisplayLabel}`;
  if (sourceType === "A_LA_CARTE") return "Manual YouTube";
  return "Unclassified Sources";
}

/** Shared by listDerivedGroupsForProject and its batched sibling listDerivedGroupsForProjects — groups already-classified rows (from ONE project) by groupKey, preferring a representative row that resolved a real channel name over an id-only fallback. */
function groupClassificationRows(rows: DerivedGroupClassification[]): DerivedGroupDescriptor[] {
  const byGroup = new Map<string, { rep: DerivedGroupClassification; memberSourceIds: number[] }>();
  for (const row of rows) {
    const existing = byGroup.get(row.groupKey);
    if (!existing) {
      byGroup.set(row.groupKey, { rep: row, memberSourceIds: [row.sourceId] });
      continue;
    }
    existing.memberSourceIds.push(row.sourceId);
    // Prefer a representative row that actually resolved a channel name over one that only has the raw id — never overwrite a resolved name with an id-only fallback.
    if (existing.rep.sourceType === "CHANNEL" && !existing.rep.originDisplayLabel?.startsWith("#") && row.originDisplayLabel?.startsWith("#")) {
      existing.rep = row;
    }
  }

  return Array.from(byGroup.values()).map(({ rep, memberSourceIds }) => ({
    groupKey: rep.groupKey,
    provider: rep.provider,
    sourceType: rep.sourceType,
    originProvider: rep.originProvider,
    originContainerId: rep.originContainerId,
    title: titleFor(rep.sourceType, rep.originDisplayLabel),
    memberSourceIds,
  }));
}

/**
 * Every derived group this project currently has at least one member for —
 * never a fabricated empty group. Groups by groupKey using the shared
 * classifyDerivedGroups() pass; a group's title prefers the first row that
 * actually carries a resolved channel name (a later scan may have enriched
 * an earlier row that only had the raw channel id — see
 * projectSourceOriginsRepo.insertDiscordChannelOrigin's enrichment
 * behavior), falling back to the id-only label otherwise.
 */
export async function listDerivedGroupsForProject(pool: Pool, projectId: number): Promise<DerivedGroupDescriptor[]> {
  const rows = await classifyDerivedGroups(pool, projectId);
  return groupClassificationRows(rows);
}

/**
 * Every project_source id currently classified under `groupKey`, resolved
 * SERVER-SIDE from the exact same classification pass
 * listDerivedGroupsForProject uses — never a caller-supplied list. Returns
 * an empty array for an unknown/no-longer-populated groupKey rather than
 * throwing, matching how a persisted collection with zero members behaves.
 */
export async function listDerivedGroupMemberSourceIds(pool: Pool, projectId: number, groupKey: string): Promise<number[]> {
  const rows = await classifyDerivedGroups(pool, projectId);
  return rows.filter((row) => row.groupKey === groupKey).map((row) => row.sourceId);
}

interface ClassifyMultiProjectDbRow extends ClassifyDbRow {
  project_id: string;
}

/**
 * Phase 4L follow-up — the batched sibling of classifyDerivedGroups(), for
 * callers that need every project's derived-group members in ONE round
 * trip (e.g. the Projects list page's `collectionCount`) rather than
 * looping classifyDerivedGroups() once per project. Identical
 * classification rule (classifyRow), just scoped by `project_id = ANY($1)`
 * instead of `project_id = $1` and additionally grouped by project id.
 */
export async function classifyDerivedGroupsForProjects(pool: Pool, projectIds: number[]): Promise<Map<number, DerivedGroupClassification[]>> {
  const map = new Map<number, DerivedGroupClassification[]>();
  if (projectIds.length === 0) return map;

  const result = await pool.query<ClassifyMultiProjectDbRow>(
    `SELECT
       ps.id,
       ps.project_id,
       ps.provider,
       dc.discord_guild_id,
       dc.discord_channel_id,
       dc.discord_channel_name,
       (m.id IS NOT NULL) AS has_manual_origin,
       ps.created_at
     FROM project_sources ps
     LEFT JOIN LATERAL (
       SELECT discord_guild_id, discord_channel_id, discord_channel_name
       FROM project_source_origins o
       WHERE o.project_source_id = ps.id AND o.origin_type = 'DISCORD_CHANNEL'
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT 1
     ) dc ON true
     LEFT JOIN project_source_origins m ON m.project_source_id = ps.id AND m.origin_type = 'MANUAL'
     WHERE ps.project_id = ANY($1::bigint[]) AND ps.collection_id IS NULL
     ORDER BY ps.created_at ASC`,
    [projectIds],
  );
  for (const row of result.rows) {
    const projectId = Number(row.project_id);
    const classified = classifyRow(row);
    const list = map.get(projectId);
    if (list) list.push(classified);
    else map.set(projectId, [classified]);
  }
  return map;
}

/** Groups classifyDerivedGroupsForProjects()'s rows into DerivedGroupDescriptors per project — the batched sibling of listDerivedGroupsForProject(), same grouping/title logic, one round trip for any number of projects. */
export async function listDerivedGroupsForProjects(pool: Pool, projectIds: number[]): Promise<Map<number, DerivedGroupDescriptor[]>> {
  const byProject = await classifyDerivedGroupsForProjects(pool, projectIds);
  const result = new Map<number, DerivedGroupDescriptor[]>();
  for (const [projectId, rows] of byProject) {
    result.set(projectId, groupClassificationRows(rows));
  }
  return result;
}

export const DERIVED_GROUP_KEY_PREFIX = "derived:";

export function isDerivedGroupKey(key: string): boolean {
  return key.startsWith(DERIVED_GROUP_KEY_PREFIX);
}
