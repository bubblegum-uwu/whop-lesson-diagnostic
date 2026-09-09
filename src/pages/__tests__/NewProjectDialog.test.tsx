import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewProjectDialog } from "../NewProjectDialog";
import type { ProjectSummary } from "../../lib/projectsApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CREATED_PROJECT: ProjectSummary = {
  id: 99,
  name: "New Project",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

function renderDialog(overrides: { onClose?: () => void; onCreated?: (p: ProjectSummary) => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onCreated = overrides.onCreated ?? vi.fn();
  render(
    <NewProjectDialog backendUrl="https://backend.example.com" knoveraToken="test-token" onClose={onClose} onCreated={onCreated} />,
  );
  return { onClose, onCreated };
}

describe("NewProjectDialog (Phase 4G)", () => {
  it("opens with a Project Name field and both project type options", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Project Name")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Trading Strategies/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /General Knowledge/ })).toBeInTheDocument();
  });

  it("shows the exact Trading Strategies description", () => {
    renderDialog();
    expect(screen.getByText("Analyze and synthesize trading education and strategies.")).toBeInTheDocument();
  });

  it("shows the exact General Knowledge description", () => {
    renderDialog();
    expect(screen.getByText("Create the project now. General Knowledge synthesis is coming soon.")).toBeInTheDocument();
  });

  it("the Create Project button is disabled until both a name and a type are provided", () => {
    renderDialog();
    const createButton = screen.getByRole("button", { name: "Create Project" });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "My Project" } });
    expect(createButton).toBeDisabled(); // name only, no type yet

    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    expect(createButton).toBeEnabled();
  });

  it("shows a blank-name validation message after the field is touched and left empty", () => {
    renderDialog();
    const nameInput = screen.getByLabelText("Project Name");
    fireEvent.change(nameInput, { target: { value: "x" } });
    fireEvent.change(nameInput, { target: { value: "" } });
    fireEvent.blur(nameInput);
    expect(screen.getByText("Project name is required.")).toBeInTheDocument();
  });

  it("submits POST /api/projects with the trimmed name and TRADING_STRATEGIES when selected", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(201, { project: CREATED_PROJECT }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "  Padded Name  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backend.example.com/api/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Padded Name", projectType: "TRADING_STRATEGIES" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("submits GENERAL_KNOWLEDGE when that type is selected", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(201, { project: { ...CREATED_PROJECT, projectType: "GENERAL_KNOWLEDGE" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Knowledge Base" } });
    fireEvent.click(screen.getByRole("radio", { name: /General Knowledge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).projectType).toBe("GENERAL_KNOWLEDGE");
  });

  it("disables the form and shows Creating… while the request is in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Slow Project" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByLabelText("Project Name")).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Trading Strategies/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // In the real app, onCreated triggers an immediate navigate() that
    // unmounts this dialog — so the correct behavior here is that the
    // request resolves and the parent is notified, not that the dialog
    // reverts itself out of the submitting state on its own.
    resolveFetch(jsonResponse(201, { project: CREATED_PROJECT }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED_PROJECT));
  });

  it("prevents duplicate submissions while a request is already in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Click Happy" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));

    const submitButton = screen.getByRole("button", { name: "Create Project" });
    fireEvent.click(submitButton);
    // The button is now disabled/relabeled, so a second physical click can't
    // resubmit through the UI — but assert the underlying guard too.
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(201, { project: CREATED_PROJECT }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("shows the backend's validation error and keeps the dialog open, without navigating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: { message: "Project name cannot be blank.", type: "invalid_name" } })),
    );
    const { onCreated, onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Whatever" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    expect(await screen.findByText("Project name cannot be blank.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows retrying after a backend error — the form re-enables", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "Project name cannot be blank.", type: "invalid_name" } }))
      .mockResolvedValueOnce(jsonResponse(201, { project: CREATED_PROJECT }));
    vi.stubGlobal("fetch", fetchMock);
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Retry Me" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
    await screen.findByText("Project name cannot be blank.");

    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED_PROJECT));
  });

  it("calls onCreated with the real created project on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(201, { project: CREATED_PROJECT })));
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "New Project" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED_PROJECT));
  });

  it("Cancel closes the dialog without calling the API at all", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText("Project Name"), { target: { value: "Never Created" } });
    fireEvent.click(screen.getByRole("radio", { name: /Trading Strategies/ }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes the dialog without calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole("dialog").parentElement!);

    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
