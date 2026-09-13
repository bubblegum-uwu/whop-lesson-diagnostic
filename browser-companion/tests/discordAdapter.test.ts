import { describe, it, expect } from "vitest";
import { findRenderedMessageElements, adaptMessageElement, findScroller, findChannelName } from "../src/discordAdapter.js";
import { createMessageList } from "./fixtures/discordDom.js";

describe("findRenderedMessageElements / adaptMessageElement", () => {
  it("3: extracts the Discord message id from a data-list-item-id attribute", () => {
    const container = createMessageList(document, [{ messageId: "1219022089252503999", postedAt: "2026-09-12T14:30:00.000Z" }]);
    document.body.appendChild(container);
    try {
      const [el] = findRenderedMessageElements(container);
      expect(adaptMessageElement(el!)!.messageId).toBe("1219022089252503999");
    } finally {
      container.remove();
    }
  });

  it("3: extracts the Discord message id from a DOM id attribute (the adapter's second extraction path)", () => {
    const container = createMessageList(document, [{ messageId: "1219022089252503999", postedAt: "2026-09-12T14:30:00.000Z", useDomId: true }]);
    document.body.appendChild(container);
    try {
      const [el] = findRenderedMessageElements(container);
      expect(adaptMessageElement(el!)!.messageId).toBe("1219022089252503999");
    } finally {
      container.remove();
    }
  });

  it("4: extracts the message's posted timestamp from its <time datetime> child", () => {
    const container = createMessageList(document, [{ messageId: "1219022089252503001", postedAt: "2026-09-12T14:30:00.000Z" }]);
    document.body.appendChild(container);
    try {
      const [el] = findRenderedMessageElements(container);
      expect(adaptMessageElement(el!)!.postedAt).toBe("2026-09-12T14:30:00.000Z");
    } finally {
      container.remove();
    }
  });

  it("collects every anchor href on the message element", () => {
    const container = createMessageList(document, [
      { messageId: "1219022089252503002", postedAt: "2026-09-12T14:30:00.000Z", hrefs: ["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://example.com/"] },
    ]);
    document.body.appendChild(container);
    try {
      const [el] = findRenderedMessageElements(container);
      expect(adaptMessageElement(el!)!.anchorHrefs).toEqual(["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://example.com/"]);
    } finally {
      container.remove();
    }
  });

  it("returns null (never throws) for a message element missing a timestamp", () => {
    const li = document.createElement("li");
    li.setAttribute("data-list-item-id", "chat-messages___chat-messages-12345678901234567");
    expect(adaptMessageElement(li)).toBeNull();
  });

  it("returns null for an element with no recognizable message id", () => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.setAttribute("datetime", "2026-09-12T14:30:00.000Z");
    li.appendChild(time);
    expect(adaptMessageElement(li)).toBeNull();
  });
});

describe("findScroller", () => {
  it("finds the scrollable message-list container", () => {
    const container = createMessageList(document, []);
    document.body.appendChild(container);
    try {
      expect(findScroller(document)).toBe(container);
    } finally {
      container.remove();
    }
  });
});

const CHANNEL_ID = "1219022089252503632";

describe("findChannelName", () => {
  it("extracts a real-style channel heading (an <h1> in the header, above the message list) when nothing outranks it", () => {
    const header = document.createElement("header");
    const h1 = document.createElement("h1");
    h1.textContent = "pre-market-live";
    header.appendChild(h1);
    const messageList = createMessageList(document, []);
    document.body.append(header, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("pre-market-live");
    } finally {
      header.remove();
      messageList.remove();
    }
  });

  it("extracts an alternate accessible heading (role=\"heading\", not necessarily an <h1>)", () => {
    const heading = document.createElement("div");
    heading.setAttribute("role", "heading");
    heading.textContent = "daily-setups";
    const messageList = createMessageList(document, []);
    document.body.append(heading, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("daily-setups");
    } finally {
      heading.remove();
      messageList.remove();
    }
  });

  it("uses the selected nav item matching the channel id when no header heading is present", () => {
    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    nav.textContent = "trade-ideas";
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("trade-ideas");
    } finally {
      nav.remove();
    }
  });

  it("never uses unrelated visible text — a heading inside the message list, or a selected nav item for a DIFFERENT channel, are both ignored", () => {
    const messageList = createMessageList(document, []);
    const headingInsideMessages = document.createElement("h1");
    headingInsideMessages.textContent = "someone's message that looks like a heading";
    messageList.appendChild(headingInsideMessages);

    const wrongChannelNav = document.createElement("div");
    wrongChannelNav.setAttribute("aria-selected", "true");
    wrongChannelNav.setAttribute("data-list-item-id", "channels___999999999999999999");
    wrongChannelNav.textContent = "unrelated-channel";

    document.body.append(wrongChannelNav, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBeNull();
    } finally {
      wrongChannelNav.remove();
      messageList.remove();
    }
  });

  it("returns null (never fabricated) when no trustworthy name is found anywhere — the caller falls back to \"channel <id>\"", () => {
    expect(findChannelName(document, CHANNEL_ID)).toBeNull();
  });

  // PR #32 second live-validation follow-up: a generic header heading can
  // render a COMPOSITE label (server/category name + channel name) —
  // the exact-channel-id-correlated nav item must always outrank it.
  it("1: a composite server+channel header PLUS a selected exact-channel nav item → the nav item's precise name wins, never the composite string", () => {
    const header = document.createElement("header");
    const h1 = document.createElement("h1");
    h1.textContent = "The Accelerator: 🚨︱scarface-alerts";
    header.appendChild(h1);

    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    nav.textContent = "scarface-alerts";

    const messageList = createMessageList(document, []);
    document.body.append(nav, header, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
      header.remove();
      messageList.remove();
    }
  });

  it("2: with no selected exact-channel nav item, a trustworthy (non-composite) channel heading is still used", () => {
    const header = document.createElement("header");
    const h1 = document.createElement("h1");
    h1.textContent = "scarface-alerts";
    header.appendChild(h1);
    const messageList = createMessageList(document, []);
    document.body.append(header, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      header.remove();
      messageList.remove();
    }
  });

  it("3: no trustworthy name anywhere → null, so the caller falls back to the channel id", () => {
    const header = document.createElement("header");
    header.innerHTML = "<div>Loading…</div>";
    document.body.appendChild(header);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBeNull();
    } finally {
      header.remove();
    }
  });

  it("4: an unrelated server/category heading never wins over the exact-channel-id nav match, even when no separator is present to normalize away", () => {
    const header = document.createElement("header");
    const h1 = document.createElement("h1");
    h1.textContent = "Totally Unrelated Server Name";
    header.appendChild(h1);

    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    nav.textContent = "scarface-alerts";

    const messageList = createMessageList(document, []);
    document.body.append(nav, header, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
      header.remove();
      messageList.remove();
    }
  });

  it("strips a purely decorative leading '#' from the selected nav item's text", () => {
    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    nav.textContent = "# scarface-alerts";
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("a channel-correlated header element without an explicit selected marker still outranks a generic heading", () => {
    const header = document.createElement("header");
    const h1 = document.createElement("h1");
    h1.textContent = "The Accelerator: 🚨︱scarface-alerts";
    header.appendChild(h1);

    const channelSpecificEl = document.createElement("div");
    channelSpecificEl.id = `channel-header-${CHANNEL_ID}`;
    channelSpecificEl.setAttribute("aria-label", "scarface-alerts");
    header.appendChild(channelSpecificEl);

    const messageList = createMessageList(document, []);
    document.body.append(header, messageList);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      header.remove();
      messageList.remove();
    }
  });
});

// PR #32 third live-validation follow-up: real Discord composites
// unread/notification state, the channel's type annotation, and its
// privacy/lock status into the SAME accessible label/text as the channel
// name itself — none of that metadata belongs in the persisted name.
describe("findChannelName — metadata normalization", () => {
  function selectedNavItem(text: string): HTMLElement {
    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    nav.textContent = text;
    return nav;
  }

  it("1: the exact live-observed composite label normalizes to just the channel name", () => {
    const nav = selectedNavItem("#unread, 🚨 | scarface-alerts (announcement channel), Private Channel (locked)");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("2: a channel-type annotation is stripped", () => {
    const nav = selectedNavItem("#general (text channel)");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("general");
    } finally {
      nav.remove();
    }
  });

  it("3: a trailing privacy/lock annotation is stripped", () => {
    const nav = selectedNavItem("#general, Private Channel (locked)");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("general");
    } finally {
      nav.remove();
    }
  });

  it("4: a server/category prefix before a colon, then a decorative emoji divider, both resolve down to the channel name", () => {
    const nav = selectedNavItem("The Accelerator: 🚨 | scarface-alerts");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("normalizes correctly even when status/type/privacy text is split across separate child elements (not just one string)", () => {
    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);

    const statusSpan = document.createElement("span");
    statusSpan.textContent = "#unread, 🚨 |";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = "scarface-alerts";
    const typeSpan = document.createElement("span");
    typeSpan.textContent = "(announcement channel), Private Channel (locked)";
    nav.append(statusSpan, nameSpan, typeSpan);

    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("6: a legitimate hyphenated channel name is never mangled by normalization", () => {
    const nav = selectedNavItem("pre-market-live");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("pre-market-live");
    } finally {
      nav.remove();
    }
  });

  it("7: a label that is ENTIRELY status/privacy metadata (no real name segment) yields null — the caller falls back to the channel id", () => {
    const nav = selectedNavItem("#unread, Private Channel (locked)");
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBeNull();
    } finally {
      nav.remove();
    }
  });
});

// PR #32 fourth live-validation follow-up — regression: the "prefer a
// clean-looking descendant" heuristic from the previous fix let an
// unread-count badge ("1") win over the real channel name. Replaced with:
// an element's own aria-label (if present) always wins outright per the
// ARIA spec; otherwise its accessible text EXCLUDING any aria-hidden="true"
// descendant (also a real ARIA rule, not a guess) — never a scan that
// picks "whichever descendant looks clean."
describe("findChannelName — unread/status badges never win (regression)", () => {
  function selectedNavItemEl(): HTMLElement {
    const nav = document.createElement("div");
    nav.setAttribute("aria-selected", "true");
    nav.setAttribute("data-list-item-id", `channels___${CHANNEL_ID}`);
    return nav;
  }

  it("1: an aria-hidden unread-count badge (\"1\") alongside the real channel name — the badge never wins", () => {
    const nav = selectedNavItemEl();
    const badge = document.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "1";
    const name = document.createTextNode("scarface-alerts");
    nav.append(badge, name);

    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("2: a composite aria-label plus an unrelated numeric descendant (\"1\") — the aria-label always wins, the descendant is never consulted", () => {
    const nav = selectedNavItemEl();
    nav.setAttribute("aria-label", "#unread, 🚨 | scarface-alerts (announcement channel), Private Channel (locked)");
    const badge = document.createElement("span");
    badge.textContent = "1";
    nav.appendChild(badge);

    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("3: a legitimate channel name containing digits (room-101) is never rejected or mangled", () => {
    const nav = selectedNavItemEl();
    nav.textContent = "room-101";
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("room-101");
    } finally {
      nav.remove();
    }
  });

  it("4: a legitimate channel name containing digits (options-0dte) is never rejected or mangled", () => {
    const nav = selectedNavItemEl();
    nav.textContent = "options-0dte";
    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("options-0dte");
    } finally {
      nav.remove();
    }
  });

  it("5: an aria-hidden emoji/status descendant rendered BEFORE the real name text never wins", () => {
    const nav = selectedNavItemEl();
    const emoji = document.createElement("span");
    emoji.setAttribute("aria-hidden", "true");
    emoji.textContent = "🚨";
    const name = document.createTextNode("scarface-alerts");
    nav.append(emoji, name);

    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });

  it("6: an aria-hidden lock/privacy descendant never becomes the name", () => {
    const nav = selectedNavItemEl();
    const lockStatus = document.createElement("span");
    lockStatus.setAttribute("aria-hidden", "true");
    lockStatus.textContent = "🔒 Private Channel (locked)";
    const name = document.createTextNode("scarface-alerts");
    nav.append(lockStatus, name);

    document.body.appendChild(nav);
    try {
      expect(findChannelName(document, CHANNEL_ID)).toBe("scarface-alerts");
    } finally {
      nav.remove();
    }
  });
});
