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
// either semantically meaningful (a heading, an ARIA selected-state) or
// directly correlated to the channel id we already know from the URL —
// never "whatever text looks plausible."
//
// Tier 1 — an accessible heading (<h1> or role="heading") that appears
// BEFORE the message-list scroller in document order. Discord always
// renders the channel header above the chat log, so this position check
// is what keeps an incidental heading-like element elsewhere on the page
// (e.g. inside a modal, or some other UI chrome) from ever being mistaken
// for the channel title.
//
// Tier 2 — the channel navigation item that is BOTH marked as the
// currently-selected item (aria-selected="true", or a class name
// containing "selected" as a fallback for older/differently-labelled
// markup) AND whose own id/href encodes the exact channel id we're
// scanning. Correlating by channel id — not just "whatever looks
// selected" — is what prevents ever picking a different, unrelated
// selected-looking element by accident.
const HEADING_SELECTOR = 'h1, [role="heading"]';
const SELECTED_NAV_ITEM_SELECTOR = '[aria-selected="true"], [class*="selected"]';

function isBeforeMessageList(root: ParentNode, el: Element): boolean {
  const scroller = findScroller(root);
  if (!scroller) return true; // no message list rendered yet to compare against — don't over-constrain
  if (scroller === el || scroller.contains(el)) return false; // inside (or is) the message list itself — never the channel header
  // DOCUMENT_POSITION_FOLLOWING on the result of comparing FROM `el` means
  // "the scroller follows el" — i.e. el sits before it, exactly the
  // "above the chat log" position a real channel header always has.
  return (el.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function findHeadingChannelName(root: ParentNode): string | null {
  for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
    if (!isBeforeMessageList(root, heading)) continue;
    const text = heading.textContent?.trim();
    if (text) return text;
  }
  return null;
}

function findSelectedNavItemChannelName(root: ParentNode, channelId: string): string | null {
  for (const candidate of root.querySelectorAll(SELECTED_NAV_ITEM_SELECTOR)) {
    const listItemId = candidate.getAttribute("data-list-item-id") ?? "";
    const href = candidate.getAttribute("href") ?? "";
    const id = candidate.id ?? "";
    if (!listItemId.includes(channelId) && !href.includes(channelId) && !id.includes(channelId)) continue;
    const text = candidate.textContent?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Ordered fallback: an accessible channel-header heading, then a
 * selected-nav-item correlated to `channelId`, then (handled by the
 * caller, see discordContentScript.ts) `channel <channelId>` — never
 * fabricated, and never inferred from message-body or username text.
 */
export function findChannelName(root: ParentNode, channelId: string): string | null {
  return findHeadingChannelName(root) ?? findSelectedNavItemChannelName(root, channelId);
}
