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
  it("1: extracts a real-style channel heading (an <h1> in the header, above the message list)", () => {
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

  it("2: extracts an alternate accessible heading (role=\"heading\", not necessarily an <h1>)", () => {
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

  it("3: falls back to the selected nav item matching the channel id when no header heading is present", () => {
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

  it("4: never uses unrelated visible text — a heading inside the message list, or a selected nav item for a DIFFERENT channel, are both ignored", () => {
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

  it("5: returns null (never fabricated) when no trustworthy name is found anywhere — the caller falls back to \"channel <id>\"", () => {
    expect(findChannelName(document, CHANNEL_ID)).toBeNull();
  });
});
