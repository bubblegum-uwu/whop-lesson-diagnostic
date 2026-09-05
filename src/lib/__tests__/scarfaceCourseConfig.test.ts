import { describe, it, expect, beforeEach } from "vitest";
import { getWhopClientId, SCARFACE_COURSE } from "../scarfaceCourseConfig";

describe("SCARFACE_COURSE", () => {
  it("holds the one course this frontend targets, in one place", () => {
    expect(SCARFACE_COURSE).toEqual({
      courseId: "cors_4lb7N3oassoZwHJvrufOYy",
      experienceId: "exp_gdmood6JIzSsE7",
      slug: "scarface-trades-mastermind",
    });
  });
});

describe("getWhopClientId", () => {
  const originalClientId = import.meta.env.VITE_WHOP_CLIENT_ID;

  beforeEach(() => {
    import.meta.env.VITE_WHOP_CLIENT_ID = originalClientId;
  });

  it("returns the configured client id", () => {
    import.meta.env.VITE_WHOP_CLIENT_ID = "app_abc123";
    expect(getWhopClientId()).toBe("app_abc123");
  });

  it("returns null when unset", () => {
    import.meta.env.VITE_WHOP_CLIENT_ID = "";
    expect(getWhopClientId()).toBeNull();
    delete (import.meta.env as Record<string, unknown>).VITE_WHOP_CLIENT_ID;
    expect(getWhopClientId()).toBeNull();
  });
});
