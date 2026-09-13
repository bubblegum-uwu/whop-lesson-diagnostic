/** Minimal builders for Discord-shaped DOM fixtures — used across the companion's test suite instead of live Discord (unavailable in this environment). */

export interface FixtureMessage {
  messageId: string;
  postedAt: string;
  hrefs?: string[];
  /** Use the DOM `id` attribute instead of `data-list-item-id`, to exercise the adapter's second extraction path. */
  useDomId?: boolean;
}

export function createMessageElement(doc: Document, msg: FixtureMessage): HTMLLIElement {
  const li = doc.createElement("li");
  if (msg.useDomId) {
    li.id = `chat-messages-${msg.messageId}`;
  } else {
    li.setAttribute("data-list-item-id", `chat-messages___chat-messages-${msg.messageId}`);
  }
  const time = doc.createElement("time");
  time.setAttribute("datetime", msg.postedAt);
  li.appendChild(time);
  for (const href of msg.hrefs ?? []) {
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    a.textContent = href;
    li.appendChild(a);
  }
  return li;
}

export function createMessageList(doc: Document, messages: FixtureMessage[]): HTMLDivElement {
  const container = doc.createElement("div");
  container.setAttribute("data-list-id", "chat-messages");
  for (const msg of messages) {
    container.appendChild(createMessageElement(doc, msg));
  }
  return container;
}
