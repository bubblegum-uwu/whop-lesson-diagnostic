import { describe, it, expect, vi, afterEach } from "vitest";
import { createWhopCourseClient, fetchAllCourseLessons } from "../src/whop/courseClient.js";
import { WhopUnauthorizedError, WhopForbiddenError, WhopNotFoundError } from "../src/whop/client.js";

const API_BASE = "https://api.whop.com/api/v1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createWhopCourseClient.fetchCourse", () => {
  it("calls GET /courses/{id} with the bearer token and returns the parsed body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${API_BASE}/courses/cors_4lb7N3oassoZwHJvrufOYy`);
      return jsonResponse(200, {
        id: "cors_4lb7N3oassoZwHJvrufOYy",
        title: "Scarface Trades Mastermind",
        chapters: [{ id: "chap_1", title: "Foundations", order: 1, lessons: [{ id: "lesn_1", order: 1 }] }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createWhopCourseClient(API_BASE);
    const course = await client.fetchCourse("cors_4lb7N3oassoZwHJvrufOYy", "tok_abc");

    expect(course.title).toBe("Scarface Trades Mastermind");
    expect(course.chapters[0].lessons[0].id).toBe("lesn_1");
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok_abc" });
  });

  it("maps a 401 to WhopUnauthorizedError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: { message: "bad token", type: "unauthorized" } })),
    );
    const client = createWhopCourseClient(API_BASE);
    await expect(client.fetchCourse("cors_x", "tok")).rejects.toBeInstanceOf(WhopUnauthorizedError);
  });

  it("maps a 403 to WhopForbiddenError and a 404 to WhopNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: { message: "no access", type: "forbidden" } })));
    const client = createWhopCourseClient(API_BASE);
    await expect(client.fetchCourse("cors_x", "tok")).rejects.toBeInstanceOf(WhopForbiddenError);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: { message: "missing", type: "not_found" } })));
    await expect(client.fetchCourse("cors_x", "tok")).rejects.toBeInstanceOf(WhopNotFoundError);
  });
});

describe("createWhopCourseClient.fetchCourseLessonsPage", () => {
  it("sends course_id and first as query params, and after when given", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { data: [], page_info: { end_cursor: null, has_next_page: false } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createWhopCourseClient(API_BASE);
    await client.fetchCourseLessonsPage("cors_x", "tok", "cursor_123");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/v1/course_lessons");
    expect(url.searchParams.get("course_id")).toBe("cors_x");
    expect(url.searchParams.get("after")).toBe("cursor_123");
  });
});

describe("fetchAllCourseLessons", () => {
  it("follows page_info.has_next_page until exhausted, concatenating every page", async () => {
    const client = {
      fetchCourse: vi.fn(),
      fetchCourseLessonsPage: vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: "lesn_1" }, { id: "lesn_2" }],
          page_info: { end_cursor: "cursor_a", has_next_page: true },
        })
        .mockResolvedValueOnce({
          data: [{ id: "lesn_3" }],
          page_info: { end_cursor: null, has_next_page: false },
        }),
    };

    const all = await fetchAllCourseLessons(client as never, "cors_x", "tok");
    expect(all.map((l: { id: string }) => l.id)).toEqual(["lesn_1", "lesn_2", "lesn_3"]);
    expect(client.fetchCourseLessonsPage).toHaveBeenCalledTimes(2);
    expect(client.fetchCourseLessonsPage).toHaveBeenNthCalledWith(2, "cors_x", "tok", "cursor_a");
  });

  it("stops after one page when has_next_page is false", async () => {
    const client = {
      fetchCourse: vi.fn(),
      fetchCourseLessonsPage: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "only" }], page_info: { end_cursor: null, has_next_page: false } }),
    };
    const all = await fetchAllCourseLessons(client as never, "cors_x", "tok");
    expect(all).toHaveLength(1);
    expect(client.fetchCourseLessonsPage).toHaveBeenCalledTimes(1);
  });
});
