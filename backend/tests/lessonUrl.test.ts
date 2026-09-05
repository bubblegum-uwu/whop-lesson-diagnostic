import { describe, it, expect } from "vitest";
import { buildLessonSourceUrl } from "../src/whop/lessonUrl.js";

describe("buildLessonSourceUrl", () => {
  it("matches the exact documented Scarface Trades Mastermind lesson URL shape", () => {
    const url = buildLessonSourceUrl(
      "scarface-trades-mastermind",
      "exp_gdmood6JIzSsE7",
      "cors_4lb7N3oassoZwHJvrufOYy",
      "lesn_6XyV2SKHYoU4YZdlMF81kl",
    );
    expect(url).toBe(
      "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/",
    );
  });
});
