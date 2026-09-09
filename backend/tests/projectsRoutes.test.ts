import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { createListProjectsHandler, createGetProjectHandler, createCreateProjectHandler, validateCreateProjectBody } from "../src/http/routes/projects.js";
import { listProjects } from "../src/db/projectsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
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

describe("validateCreateProjectBody (Phase 4G)", () => {
  it("accepts a valid TRADING_STRATEGIES payload", () => {
    const result = validateCreateProjectBody({ name: "My Course", projectType: "TRADING_STRATEGIES" });
    expect(result).toEqual({ ok: true, value: { name: "My Course", projectType: "TRADING_STRATEGIES" } });
  });

  it("accepts a valid GENERAL_KNOWLEDGE payload", () => {
    const result = validateCreateProjectBody({ name: "My Library", projectType: "GENERAL_KNOWLEDGE" });
    expect(result.ok).toBe(true);
  });

  it("trims leading/trailing whitespace from the name", () => {
    const result = validateCreateProjectBody({ name: "  Padded Name  ", projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Padded Name");
  });

  it("rejects a blank name", () => {
    const result = validateCreateProjectBody({ name: "", projectType: "TRADING_STRATEGIES" });
    expect(result).toEqual({ ok: false, error: { message: "Project name cannot be blank.", type: "invalid_name" } });
  });

  it("rejects a whitespace-only name", () => {
    const result = validateCreateProjectBody({ name: "   ", projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_name");
  });

  it("rejects a missing name", () => {
    const result = validateCreateProjectBody({ projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_name");
  });

  it("rejects a non-string name", () => {
    const result = validateCreateProjectBody({ name: 12345 as unknown as string, projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(false);
  });

  it("rejects a name over the max length", () => {
    const result = validateCreateProjectBody({ name: "x".repeat(201), projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_name");
  });

  it("accepts a name exactly at the max length", () => {
    const result = validateCreateProjectBody({ name: "x".repeat(200), projectType: "TRADING_STRATEGIES" });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid projectType", () => {
    const result = validateCreateProjectBody({ name: "Valid Name", projectType: "SOMETHING_ELSE" });
    expect(result).toEqual({
      ok: false,
      error: { message: "projectType must be one of TRADING_STRATEGIES or GENERAL_KNOWLEDGE.", type: "invalid_project_type" },
    });
  });

  it("rejects a missing projectType", () => {
    const result = validateCreateProjectBody({ name: "Valid Name" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_project_type");
  });

  it("rejects lowercase or differently-cased projectType values (case-sensitive, no coercion)", () => {
    const result = validateCreateProjectBody({ name: "Valid Name", projectType: "trading_strategies" });
    expect(result.ok).toBe(false);
  });

  it("handles unusual but legitimate name characters safely (emoji, unicode, quotes, SQL-special characters)", () => {
    const weirdNames = [
      "📈 Trading 101",
      "Étude générale",
      `O'Brien's Strategies`,
      `"Quoted" Project`,
      "Robert'); DROP TABLE projects;--",
      "日本語のプロジェクト",
    ];
    for (const name of weirdNames) {
      const result = validateCreateProjectBody({ name, projectType: "GENERAL_KNOWLEDGE" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.name).toBe(name);
    }
  });
});

describe("POST /api/projects (Phase 4G)", () => {
  it("creates a project and returns 201 with the full project shape", async () => {
    const handler = createCreateProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();
    const name = randomId("route-created");

    await handler({ body: { name, projectType: "TRADING_STRATEGIES" } } as unknown as Request, res);

    expect(statusCode()).toBe(201);
    const { project } = body() as { project: { id: number; name: string; projectType: string; courseCount: number } };
    expect(project.name).toBe(name);
    expect(project.projectType).toBe("TRADING_STRATEGIES");
    expect(project.courseCount).toBe(0);
  });

  it("creates a GENERAL_KNOWLEDGE project and returns 201", async () => {
    const handler = createCreateProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { name: randomId("gk"), projectType: "GENERAL_KNOWLEDGE" } } as unknown as Request, res);

    expect(statusCode()).toBe(201);
    expect((body() as { project: { projectType: string } }).project.projectType).toBe("GENERAL_KNOWLEDGE");
  });

  it("returns a deterministic 400 for a blank name", async () => {
    const handler = createCreateProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { name: "  ", projectType: "TRADING_STRATEGIES" } } as unknown as Request, res);

    expect(statusCode()).toBe(400);
    expect((body() as { error: { type: string } }).error.type).toBe("invalid_name");
  });

  it("returns a deterministic 400 for an invalid projectType", async () => {
    const handler = createCreateProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { name: "Valid", projectType: "NOT_A_TYPE" } } as unknown as Request, res);

    expect(statusCode()).toBe(400);
    expect((body() as { error: { type: string } }).error.type).toBe("invalid_project_type");
  });

  it("a created project immediately appears in GET /api/projects", async () => {
    const createHandler = createCreateProjectHandler({ pool });
    const name = randomId("appears-in-list");
    const created = makeResponse();
    await createHandler({ body: { name, projectType: "TRADING_STRATEGIES" } } as unknown as Request, created.res);
    const { project } = created.body() as { project: { id: number } };

    const listHandler = createListProjectsHandler({ pool });
    const listed = makeResponse();
    await listHandler({} as Request, listed.res);
    const { projects } = listed.body() as { projects: Array<{ id: number; name: string }> };

    expect(projects.some((p) => p.id === project.id && p.name === name)).toBe(true);
  });

  it("a created project is immediately readable via GET /api/projects/:id", async () => {
    const createHandler = createCreateProjectHandler({ pool });
    const created = makeResponse();
    await createHandler({ body: { name: randomId("readable"), projectType: "GENERAL_KNOWLEDGE" } } as unknown as Request, created.res);
    const { project } = created.body() as { project: { id: number } };

    const getHandler = createGetProjectHandler({ pool });
    const got = makeResponse();
    await getHandler({ params: { projectId: String(project.id) } } as unknown as Request, got.res);

    expect(got.statusCode()).toBe(200);
    expect((got.body() as { project: { id: number } }).project.id).toBe(project.id);
  });

  it("duplicate project names are allowed (id, not name, is canonical)", async () => {
    const handler = createCreateProjectHandler({ pool });
    const name = randomId("duplicate-ok");

    const first = makeResponse();
    await handler({ body: { name, projectType: "TRADING_STRATEGIES" } } as unknown as Request, first.res);
    const second = makeResponse();
    await handler({ body: { name, projectType: "TRADING_STRATEGIES" } } as unknown as Request, second.res);

    expect(first.statusCode()).toBe(201);
    expect(second.statusCode()).toBe(201);
    const firstId = (first.body() as { project: { id: number } }).project.id;
    const secondId = (second.body() as { project: { id: number } }).project.id;
    expect(firstId).not.toBe(secondId);
  });

  it("handles unusual name characters end to end through the real handler + database round-trip", async () => {
    const handler = createCreateProjectHandler({ pool });
    const name = `Robert'); DROP TABLE projects;-- 📈 日本語`;
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { name, projectType: "GENERAL_KNOWLEDGE" } } as unknown as Request, res);

    expect(statusCode()).toBe(201);
    expect((body() as { project: { name: string } }).project.name).toBe(name);

    const listHandler = createListProjectsHandler({ pool });
    const listed = makeResponse();
    await listHandler({} as Request, listed.res);
    const { projects } = listed.body() as { projects: Array<{ name: string }> };
    expect(projects.some((p) => p.name === name)).toBe(true);
  });
});
