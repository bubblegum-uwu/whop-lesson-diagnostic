import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function MockOAuth2Client(this: { verifyIdToken: typeof verifyIdToken }) {
    this.verifyIdToken = verifyIdToken;
  }),
}));

const { createGoogleOidcVerifier, InvalidOidcTokenError } = await import("../src/lib/googleOidc.js");

const AUDIENCE = "https://whop-lesson-gemini-backend-abc.a.run.app";
const EXPECTED_SA = "scheduler-sa@scarface-video-ai.iam.gserviceaccount.com";

describe("createGoogleOidcVerifier", () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
  });

  it("accepts a token whose verified email matches the configured Scheduler service account", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: true }),
    });
    const verifier = createGoogleOidcVerifier(AUDIENCE, EXPECTED_SA);
    await expect(verifier.verify("valid-token")).resolves.toEqual({ email: EXPECTED_SA });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "valid-token", audience: AUDIENCE });
  });

  it("rejects a token that fails Google signature verification", async () => {
    verifyIdToken.mockRejectedValue(new Error("Wrong number of segments"));
    const verifier = createGoogleOidcVerifier(AUDIENCE, EXPECTED_SA);
    await expect(verifier.verify("garbage")).rejects.toBeInstanceOf(InvalidOidcTokenError);
  });

  it("rejects a genuinely Google-signed token belonging to a DIFFERENT service account (never CORS/Origin/shared-secret substitutes)", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "someone-else@another-project.iam.gserviceaccount.com", email_verified: true }),
    });
    const verifier = createGoogleOidcVerifier(AUDIENCE, EXPECTED_SA);
    await expect(verifier.verify("valid-but-wrong-identity")).rejects.toBeInstanceOf(InvalidOidcTokenError);
  });

  it("rejects a token with an unverified email claim", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: false }),
    });
    const verifier = createGoogleOidcVerifier(AUDIENCE, EXPECTED_SA);
    await expect(verifier.verify("token")).rejects.toBeInstanceOf(InvalidOidcTokenError);
  });

  it("rejects a token with no payload at all", async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => undefined });
    const verifier = createGoogleOidcVerifier(AUDIENCE, EXPECTED_SA);
    await expect(verifier.verify("token")).rejects.toBeInstanceOf(InvalidOidcTokenError);
  });
});
