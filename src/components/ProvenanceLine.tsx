import type { ProjectSourceOriginSummary } from "../lib/sourcesApi";

/** "Posted: Sep 12, 2026" — the Discord MESSAGE's timestamp, rendered in the viewer's local timezone; the stored value is always UTC (see sourcesApi.ts's ProjectSourceOriginSummary doc comment). */
function formatPostedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "#channel-name" when the companion could safely derive one, else a safe fallback to the raw channel id — never a fabricated name (Phase 4K-C spec). */
function discordChannelDisplayName(origin: ProjectSourceOriginSummary): string {
  return origin.discordChannelName ? `#${origin.discordChannelName}` : `channel ${origin.discordChannelId}`;
}

function originDetailLine(origin: ProjectSourceOriginSummary): string {
  return origin.originType === "MANUAL" ? "Manual" : `Discord · ${discordChannelDisplayName(origin)} / Posted: ${formatPostedAt(origin.discordPostedAt!)}`;
}

/** MAX(discordPostedAt) across every Discord origin — never YouTube's publish date, an import time, or a scan time (see ProjectSourceOriginSummary's own doc comment). Assumes at least one Discord origin is present. */
function latestDiscordPostedAt(discordOrigins: ProjectSourceOriginSummary[]): string {
  return discordOrigins.reduce(
    (latest, o) => (new Date(o.discordPostedAt!).getTime() > new Date(latest).getTime() ? o.discordPostedAt! : latest),
    discordOrigins[0].discordPostedAt!,
  );
}

/**
 * Phase 4K-C — the compact "Source: …" provenance block for a YouTube
 * source row. A source with no known origins (every source that predates
 * this phase) renders nothing here — never a fabricated "Manual" label,
 * per the spec's historical-data rule.
 *
 * Live-validation follow-up: a Discord posted date must stay visible in
 * the COLLAPSED row whenever at least one Discord origin exists — a
 * viewer should never have to expand provenance just to see when a video
 * was posted. A single Discord origin (with or without an accompanying
 * Manual origin) always names its exact channel and posted date inline;
 * only once there are MULTIPLE Discord origins does the row collapse to a
 * post count, and even then it still shows the latest posted date. Every
 * individual origin — channel, message, and its own posted date — remains
 * available via the expandable detail list, never discarded for the sake
 * of the compact summary.
 *
 * Phase 4L — extracted from SourcesPage.tsx into its own shared
 * component (originally the only place a "Video Sources" row existed) so
 * every place a YouTube source's provenance is shown — the Uncollected
 * Sources detail page, and a Synthesis Set's Fine-Tune list — renders it
 * with these exact same rules, never a second/divergent implementation.
 */
export function ProvenanceLine({ origins }: { origins: ProjectSourceOriginSummary[] }) {
  if (origins.length === 0) return null;

  const discordOrigins = origins.filter((o) => o.originType === "DISCORD_CHANNEL");
  const hasManual = origins.some((o) => o.originType === "MANUAL");

  if (discordOrigins.length === 0) {
    // Manual-only (the DB caps MANUAL at one per source, so this is the
    // whole list) — no Discord provenance exists, so no posted date is
    // ever shown here; a date would have to be invented from nowhere.
    return <p className="knovera-youtube-source-provenance">Source: Manual</p>;
  }

  const sourceLabel =
    discordOrigins.length === 1
      ? `${hasManual ? "Manual + " : ""}Discord · ${discordChannelDisplayName(discordOrigins[0])}`
      : `${hasManual ? "Manual + " : ""}${discordOrigins.length} Discord posts`;
  const dateLabel = discordOrigins.length === 1 ? "Posted" : "Latest posted";
  const dateValue = discordOrigins.length === 1 ? discordOrigins[0].discordPostedAt! : latestDiscordPostedAt(discordOrigins);

  const summary = (
    <>
      <span className="knovera-youtube-source-provenance-source">Source: {sourceLabel}</span>
      <span className="knovera-youtube-source-provenance-posted">
        {dateLabel}: {formatPostedAt(dateValue)}
      </span>
    </>
  );

  // A single Discord origin (± Manual) already shows everything the
  // expanded list would — no need for a <details> affordance. Multiple
  // Discord origins collapse the row to a count, so the expandable detail
  // is what surfaces every individual channel/message/date.
  if (origins.length <= 2 && discordOrigins.length <= 1) {
    return <p className="knovera-youtube-source-provenance knovera-youtube-source-provenance-multiline">{summary}</p>;
  }

  return (
    <details className="knovera-youtube-source-provenance">
      <summary className="knovera-youtube-source-provenance-multiline">{summary}</summary>
      <ul>
        {origins.map((origin, i) => (
          <li key={i}>{originDetailLine(origin)}</li>
        ))}
      </ul>
    </details>
  );
}
