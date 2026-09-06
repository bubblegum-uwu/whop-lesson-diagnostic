import { OAuth2Client } from "google-auth-library";

/**
 * Verifies a Google-signed OIDC identity token — used ONLY to authorize
 * Cloud Scheduler's calls to POST /internal/ensure-worker-running. This is
 * deliberately independent of the Whop operator bearer-token model: CORS,
 * Origin headers, and a shared query-string secret are all explicitly NOT
 * acceptable substitutes (see backend/README.md "Security model"). The
 * caller must present a token whose audience matches this service's own URL
 * AND whose subject is exactly the configured Scheduler service account —
 * nothing else is trusted, including a token that is otherwise
 * Google-signed and valid but issued to a different identity.
 */
export class InvalidOidcTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOidcTokenError";
  }
}

export interface GoogleOidcVerifier {
  verify(bearerToken: string): Promise<{ email: string }>;
}

export function createGoogleOidcVerifier(audience: string, expectedServiceAccountEmail: string): GoogleOidcVerifier {
  const client = new OAuth2Client();

  async function verify(bearerToken: string): Promise<{ email: string }> {
    let ticket;
    try {
      ticket = await client.verifyIdToken({ idToken: bearerToken, audience });
    } catch (err) {
      throw new InvalidOidcTokenError(
        `Could not verify Google-signed identity token: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    const payload = ticket.getPayload();
    const email = payload?.email;
    if (!email || !payload?.email_verified) {
      throw new InvalidOidcTokenError("Identity token has no verified email claim.");
    }
    if (email !== expectedServiceAccountEmail) {
      throw new InvalidOidcTokenError("Identity token does not belong to the configured Scheduler service account.");
    }
    return { email };
  }

  return { verify };
}
