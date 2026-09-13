/**
 * Isolates every Discord-specific DOM selector/attribute-reading behind
 * this one module — discordScanner.ts's traversal logic never touches a
 * raw selector directly. When Discord changes its rendered markup, only
 * the functions in this file need updating, never the scan loop, the
 * dedup logic, or the termination condition.
 *
 * Only ever reads: a rendered message container's id/list-item attribute
 * (for the numeric Discord message id it encodes), its <time datetime>
 * child (the message's posted timestamp), and its anchor hrefs (for
 * YouTube links). Never reads message body TEXT, author/username
 * elements, avatars, or reactions — see the companion's privacy
 * requirements (no message-body or username persistence).
 */

export interface AdaptedMessageElement {
  messageId: string;
  /** ISO-8601, straight from the rendered <time datetime="..."> attribute. */
  postedAt: string;
  anchorHrefs: string[];
}

// Discord's real chat message list items carry a numeric message id at the
// end of either a `data-list-item-id` attribute (e.g.
// "chat-messages___chat-messages-1219022089252503999") or a DOM `id`
// (e.g. "chat-messages-1219022089252503999") — both forms are checked so
// a future markup tweak that drops one still works via the other.
const MESSAGE_ITEM_SELECTOR = '[data-list-item-id*="chat-messages"], [id*="chat-messages-"]';
const MESSAGE_ID_PATTERN = /(\d{15,25})$/;

function extractMessageId(el: Element): string | null {
  const listItemId = el.getAttribute("data-list-item-id");
  const fromListItemId = listItemId ? MESSAGE_ID_PATTERN.exec(listItemId)?.[1] : undefined;
  if (fromListItemId) return fromListItemId;

  const fromId = el.id ? MESSAGE_ID_PATTERN.exec(el.id)?.[1] : undefined;
  return fromId ?? null;
}

function extractPostedAt(el: Element): string | null {
  const timeEl = el.querySelector("time[datetime]");
  return timeEl?.getAttribute("datetime") ?? null;
}

function extractAnchorHrefs(el: Element): string[] {
  return Array.from(el.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.length > 0);
}

/** Every currently-rendered message element within `root` — a fresh query each call, since Discord virtualizes and swaps elements in/out as the user scrolls. */
export function findRenderedMessageElements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(MESSAGE_ITEM_SELECTOR));
}

/** Returns null (never throws) for an element missing an id or timestamp — the scanner simply skips it, since a message without those two fields can't be recorded as a provenance occurrence. */
export function adaptMessageElement(el: Element): AdaptedMessageElement | null {
  const messageId = extractMessageId(el);
  const postedAt = extractPostedAt(el);
  if (!messageId || !postedAt) return null;
  return { messageId, postedAt, anchorHrefs: extractAnchorHrefs(el) };
}

// The scrollable message-list container Discord renders the channel's
// history inside — scrolling this element toward its top reveals older
// (virtualized-in) messages.
const SCROLLER_SELECTOR = '[data-list-id="chat-messages"], [class*="scrollerInner"], [class*="scroller"][role="log"]';

export function findScroller(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(SCROLLER_SELECTOR);
}

// A best-effort read of the channel name — optional by design (see the
// spec's "if available" wording): a miss across every tier below means
// channelName stays null, never fabricated from e.g. the URL's channel
// id. Deliberately NOT keyed to one generated CSS class (those rotate
// across Discord releases); each tier instead prefers a signal that's
// either directly correlated to the channel id we already know from the
// URL, or semantically meaningful (a heading) — never "whatever text
// looks plausible."
//
// Ordered by trustworthiness, most first:
//
// Tier 1 — the channel navigation item that is BOTH marked as the
// currently-selected item (aria-selected="true", or a class name
// containing "selected" as a fallback for older/differently-labelled
// markup) AND whose own id/href encodes the exact channel id we're
// scanning. This is the single most trustworthy signal available: it can
// only ever name THIS channel, never a server/category label, so it
// outranks every other tier even when a heading is also present.
//
// Tier 2 — any OTHER element positioned in the header area (before the
// message-list scroller) whose id/href/data-list-item-id also encodes the
// exact channel id, even without an explicit "selected" marker — a
// broader net for channel-specific header markup that doesn't happen to
// carry an aria-selected/selected-class attribute.
//
// Tier 3 — a generic accessible heading (<h1> or role="heading") that
// appears before the message-list scroller, LAST because Discord's
// header sometimes renders a composite label combining the server/
// category name with the channel name (e.g. "The Accelerator:
// 🚨︱scarface-alerts") — normalizeChannelNameText below takes a
// conservative pass at stripping that composite prefix, but a tier that
// isn't correlated to the channel id at all is inherently less trustworthy
// than one that is, hence last.
//
// Every tier's raw candidate text (an aria-label, a textContent, or a
// heading's text) is run through the SAME normalizeChannelNameText/
// normalizeChannelNameSegment pipeline below — Discord's real accessible
// labels routinely pack unread/notification state, the channel's own
// type ("announcement channel"/"text channel"), and its privacy/lock
// status into one comma-separated string (e.g. "#unread, 🚨 |
// scarface-alerts (announcement channel), Private Channel (locked)") —
// none of which is part of the channel's actual name.
const HEADING_SELECTOR = 'h1, [role="heading"]';
const SELECTED_NAV_ITEM_SELECTOR = '[aria-selected="true"], [class*="selected"]';
const ID_CORRELATED_SELECTOR = "[id], [href], [data-list-item-id]";

function isBeforeMessageList(root: ParentNode, el: Element): boolean {
  const scroller = findScroller(root);
  if (!scroller) return true; // no message list rendered yet to compare against — don't over-constrain
  if (scroller === el || scroller.contains(el)) return false; // inside (or is) the message list itself — never the channel header
  // DOCUMENT_POSITION_FOLLOWING on the result of comparing FROM `el` means
  // "the scroller follows el" — i.e. el sits before it, exactly the
  // "above the chat log" position a real channel header always has.
  return (el.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function isCorrelatedToChannelId(el: Element, channelId: string): boolean {
  const listItemId = el.getAttribute("data-list-item-id") ?? "";
  const href = el.getAttribute("href") ?? "";
  const id = el.id ?? "";
  return listItemId.includes(channelId) || href.includes(channelId) || id.includes(channelId);
}

/** Strips a purely decorative leading "#" (Discord's own convention for labelling text channels, e.g. "# scarface-alerts") — never part of the channel's actual name. */
function stripDecorativeHash(text: string): string {
  return text.replace(/^#\s*/, "");
}

// Discord frequently exposes a composite ACCESSIBLE label on the exact
// element we've correlated to the channel id — e.g.
// "#unread, 🚨 | scarface-alerts (announcement channel), Private Channel (locked)"
// — packing unread/notification state, the channel name itself, its
// channel-type annotation, and its privacy/lock status into one string,
// comma-separated. None of the status/category/type segments are part of
// the channel's actual name; only the segment that (after stripping its
// own decorations) isn't one of those known-metadata phrases is.
const METADATA_SEGMENT_PATTERN =
  /^(unread|private channel|public channel|locked|announcement channel|text channel|voice channel|forum channel|stage channel|category)$/i;

/** Repeatedly strips trailing "(...)" annotations — a segment can carry more than one, e.g. "general (text channel) (locked)". */
function stripTrailingParentheticals(text: string): string {
  let result = text;
  let stripped: string;
  do {
    stripped = result.replace(/\s*\([^()]*\)\s*$/, "");
    if (stripped === result) break;
    result = stripped;
  } while (true);
  return result;
}

/**
 * Normalizes ONE comma-separated segment of a (possibly composite)
 * channel label down to a candidate name, or null if the segment is
 * itself pure status/category/type metadata with no name left in it.
 * Order matters: hash/parenthetical stripping happens first (metadata
 * annotations live in those), then the metadata-phrase check, then
 * colon-splitting (a "Server: channel" prefix), then divider-splitting
 * (a "🚨 | channel-name" decorative prefix) — colon before divider so
 * "The Accelerator: 🚨 | scarface-alerts" resolves to "scarface-alerts"
 * rather than stopping at "🚨 | scarface-alerts".
 */
function normalizeChannelNameSegment(segment: string): string | null {
  let text = stripDecorativeHash(segment.trim()).trim();
  text = stripTrailingParentheticals(text).trim();
  if (text.length === 0 || METADATA_SEGMENT_PATTERN.test(text)) return null;

  const colonIndex = text.lastIndexOf(": ");
  if (colonIndex !== -1) text = text.slice(colonIndex + 2).trim();

  const dividerMatch = /[︱|]/.exec(text);
  if (dividerMatch) text = text.slice(dividerMatch.index + 1).trim();

  return text.length > 0 ? text : null;
}

/**
 * Splits a full (possibly composite, comma-joined) label into segments
 * and returns the first one that survives `normalizeChannelNameSegment` —
 * i.e. the first segment that isn't pure status/category/type metadata.
 * A plain, uncomposed name (no comma, no divider, no annotation) simply
 * passes straight through unchanged, so a legitimate hyphenated channel
 * name like "pre-market-live" is never touched.
 */
function normalizeChannelNameText(text: string): string | null {
  for (const segment of text.split(",")) {
    const candidate = normalizeChannelNameSegment(segment);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Computes an element's accessible text the way assistive tech does: text
 * from itself and its descendants, EXCLUDING anything under an
 * `aria-hidden="true"` node. This is a real, spec-defined ARIA rule (not
 * an invented heuristic) — and it is exactly why it's safe here: a
 * decorative unread-count badge or status icon is routinely marked
 * `aria-hidden="true"` precisely because its meaning (if any) is already
 * folded into the element's own `aria-label`, so a badge marked this way
 * can never leak into the computed text no matter what it contains (a
 * count, an emoji, anything).
 */
function computeAccessibleText(el: Element): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.getAttribute("aria-hidden") === "true") continue;
      text += computeAccessibleText(child);
    }
  }
  return text;
}

/**
 * The channel-name candidate for one matched element. Deliberately NOT a
 * scan over descendants guessing which one "looks like a name" (that
 * approach previously let an unrelated unread-count badge win) — instead,
 * exactly two sources are ever considered, in order:
 *
 *   1. The element's own `aria-label`, if present — per the ARIA spec this
 *      IS the element's accessible name outright, overriding all
 *      descendant content, which is exactly why Discord (and most UI
 *      libraries) can safely compose unread/status/type/privacy metadata
 *      into it: assistive tech reads only this string, never the
 *      individual child nodes, so normalizing it is the correct move.
 *   2. Otherwise, this element's own accessible TEXT (computeAccessibleText
 *      above) — every descendant's text except whatever sits under an
 *      aria-hidden="true" node.
 *
 * Both sources are run through the same normalizeChannelNameText pipeline
 * to strip whatever status/category/type metadata they still contain.
 */
function extractChannelNameFromElement(el: Element): string | null {
  const ariaLabel = el.getAttribute("aria-label");
  const raw = (ariaLabel ?? computeAccessibleText(el))?.trim();
  return raw ? normalizeChannelNameText(raw) : null;
}

function findSelectedNavItemChannelName(root: ParentNode, channelId: string): string | null {
  for (const candidate of root.querySelectorAll(SELECTED_NAV_ITEM_SELECTOR)) {
    if (!isCorrelatedToChannelId(candidate, channelId)) continue;
    const name = extractChannelNameFromElement(candidate);
    if (name) return name;
  }
  return null;
}

function findChannelCorrelatedHeaderElementName(root: ParentNode, channelId: string): string | null {
  for (const candidate of root.querySelectorAll(ID_CORRELATED_SELECTOR)) {
    if (!isBeforeMessageList(root, candidate) || !isCorrelatedToChannelId(candidate, channelId)) continue;
    const name = extractChannelNameFromElement(candidate);
    if (name) return name;
  }
  return null;
}

function findGenericHeadingChannelName(root: ParentNode): string | null {
  for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
    if (!isBeforeMessageList(root, heading)) continue;
    const name = extractChannelNameFromElement(heading);
    if (name) return name;
  }
  return null;
}

/**
 * Ordered fallback (most trustworthy first): the selected nav item for
 * this exact `channelId`, then any other header element correlated to
 * `channelId`, then a generic (conservatively normalized) heading, then
 * (handled by the caller, see discordContentScript.ts) `channel
 * <channelId>` — never fabricated, and never inferred from message-body
 * or username text.
 */
export function findChannelName(root: ParentNode, channelId: string): string | null {
  return (
    findSelectedNavItemChannelName(root, channelId) ??
    findChannelCorrelatedHeaderElementName(root, channelId) ??
    findGenericHeadingChannelName(root)
  );
}
