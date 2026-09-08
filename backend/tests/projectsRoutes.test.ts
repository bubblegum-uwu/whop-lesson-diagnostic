import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { createListProjectsHandler, createGetProjectHandler } from "../src/http/routes/projects.js";
import { listProjects } from "../src/db/projectsRepo.js";
import { createTestPool } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

describe("GET /api/projects", () => {
  it("returns every project, including the seeded MasterMind row with its type", async () => {
    const handler = createListProjectsHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    const { projects } = body() as { projects: Array<{ name: string; projectType: string }> };
    const masterMind = projects.find((p) => p.name === "MasterMind");
    expect(masterMind).toBeDefined();
    expect(masterMind?.projectType).toBe("TRADING_STRATEGIES");
  });

  it("never returns duplicate MasterMind rows across repeated calls", async () => {
    const handler = createListProjectsHandler({ pool });

    const first = makeResponse();
    await handler({} as Request, first.res);
    const second = makeResponse();
    await handler({} as Request, second.res);

    const countMasterMinds = (body: unknown) =>
      (body as { projects: Array<{ name: string }> }).projects.filter((p) => p.name === "MasterMind").length;
    expect(countMasterMinds(first.body())).toBe(1);
    expect(countMasterMinds(second.body())).toBe(1);
  });
});

describe("GET /api/projects/:projectId", () => {
  it("returns the project for a valid id", async () => {
    const [masterMind] = await listProjects(pool);
    const handler = createGetProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ params: { projectId: String(masterMind.id) } } as unknown as Request, res);

    expect(statusCode()).toBe(200);
    expect((body() as { project: { id: number } }).project.id).toBe(masterMind.id);
  });

  it("returns a deterministic 404 for an unknown numeric id", async () => {
    const handler = createGetProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ params: { projectId: "999999999" } } as unknown as Request, res);

    expect(statusCode()).toBe(404);
    expect((body() as { error: { type: string } }).error.type).toBe("project_not_found");
  });

  it("returns a deterministic 404 for a non-numeric id rather than 500ing", async () => {
    const handler = createGetProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ params: { projectId: "mastermind" } } as unknown as Request, res);

    expect(statusCode()).toBe(404);
    expect((body() as { error: { type: string } }).error.type).toBe("project_not_found");
  });
});
