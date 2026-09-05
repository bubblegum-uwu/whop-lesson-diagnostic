import { describe, it, expect } from "vitest";
import {
  parseWhopLessonUrl,
  extractExperienceId,
  extractCourseId,
  extractLessonId,
  WhopUrlParseError,
} from "../whopUrl";

const SCARFACE_URL =
  "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/";

describe("parseWhopLessonUrl", () => {
  it("parses the exact Scarface Trades Mastermind test URL", () => {
    const result = parseWhopLessonUrl(SCARFACE_URL);
    expect(result).toEqual({
      companySlug: "scarface-trades-mastermind",
      experienceId: "exp_gdmood6JIzSsE7",
      courseId: "cors_4lb7N3oassoZwHJvrufOYy",
      lessonId: "lesn_6XyV2SKHYoU4YZdlMF81kl",
    });
  });

  it("parses the URL without a trailing slash", () => {
    const result = parseWhopLessonUrl(SCARFACE_URL.replace(/\/$/, ""));
    expect(result.lessonId).toBe("lesn_6XyV2SKHYoU4YZdlMF81kl");
  });

  it("extracts the experience ID", () => {
    expect(extractExperienceId(SCARFACE_URL)).toBe("exp_gdmood6JIzSsE7");
  });

  it("extracts the course ID", () => {
    expect(extractCourseId(SCARFACE_URL)).toBe("cors_4lb7N3oassoZwHJvrufOYy");
  });

  it("extracts the lesson ID", () => {
    expect(extractLessonId(SCARFACE_URL)).toBe("lesn_6XyV2SKHYoU4YZdlMF81kl");
  });

  it("throws WhopUrlParseError for a non-URL string", () => {
    expect(() => parseWhopLessonUrl("not a url")).toThrow(WhopUrlParseError);
  });

  it("throws WhopUrlParseError for a non-whop.com hostname", () => {
    expect(() =>
      parseWhopLessonUrl(
        "https://example.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/",
      ),
    ).toThrow(WhopUrlParseError);
  });

  it("throws WhopUrlParseError when the path shape doesn't match", () => {
    expect(() => parseWhopLessonUrl("https://whop.com/just-a-slug")).toThrow(
      WhopUrlParseError,
    );
  });

  it("throws WhopUrlParseError when the experience ID prefix is wrong", () => {
    expect(() =>
      parseWhopLessonUrl(
        "https://whop.com/scarface-trades-mastermind/notexp_123/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/",
      ),
    ).toThrow(WhopUrlParseError);
  });

  it("accepts www.whop.com as an equivalent hostname", () => {
    const result = parseWhopLessonUrl(SCARFACE_URL.replace("https://whop.com", "https://www.whop.com"));
    expect(result.lessonId).toBe("lesn_6XyV2SKHYoU4YZdlMF81kl");
  });
});
