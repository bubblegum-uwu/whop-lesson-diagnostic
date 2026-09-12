import { describe, it, expect, vi, afterEach } from "vitest";
import { addProjectSourceToProjects, AddToProjectError } from "../addToProjectApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "knovera-session-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("addProjectSourceToProjects", () => {
  it("POSTs targetProjectIds to the source's add-to-projects endpoint and returns per-project results", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/projects/1/sources/42/add-to-projects`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(init.body as string)).toEqual({ targetProjectIds: [2, 3] });
      return jsonResponse(200, {
        results: [
          { projectId: 2, kind: "added" },
          { projectId: 3, kind: "already_present" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await addProjectSourceToProjects(BACKEND_URL, TOKEN, 1, 42, [2, 3]);
    expect(result.results).toEqual([
      { projectId: 2, kind: "added" },
      { projectId: 3, kind: "already_present" },
    ]);
  });

  it("throws AddToProjectError with the backend's exact message/type when the source isn't shareable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: "Only captured Discord sources can be added to other projects right now.", type: "source_not_shareable" },
        }),
      ),
    );

    const err = await addProjectSourceToProjects(BACKEND_URL, TOKEN, 1, 42, [2]).catch((e) => e);
    expect(err).toBeInstanceOf(AddToProjectError);
    expect((err as AddToProjectError).type).toBe("source_not_shareable");
  });
});
