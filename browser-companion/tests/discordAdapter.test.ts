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

describe("findScroller / findChannelName", () => {
  it("finds the scrollable message-list container", () => {
    const container = createMessageList(document, []);
    document.body.appendChild(container);
    try {
      expect(findScroller(document)).toBe(container);
    } finally {
      container.remove();
    }
  });

  it("returns null for channel name when no title element is present — never fabricated", () => {
    expect(findChannelName(document)).toBeNull();
  });
});
