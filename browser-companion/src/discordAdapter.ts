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

// A best-effort read of the channel name from the header Discord renders
// above the message list — optional by design (see the spec's "if
// available" wording): a selector miss here means channelName stays null,
// never fabricated from e.g. the URL's channel id.
const CHANNEL_NAME_SELECTOR = '[data-list-id="chat-messages"] ~ * [class*="title"], header [class*="title"]';

export function findChannelName(root: ParentNode): string | null {
  const el = root.querySelector(CHANNEL_NAME_SELECTOR);
  const text = el?.textContent?.trim();
  return text && text.length > 0 ? text : null;
}
