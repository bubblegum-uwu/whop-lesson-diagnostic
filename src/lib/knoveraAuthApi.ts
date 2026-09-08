/**
 * Client for the Knovera application login (Phase 4D) — POST
 * /api/knovera-auth/login, GET /api/knovera-auth/me, POST
 * /api/knovera-auth/logout. Entirely separate from Whop OAuth
 * (oauth/whopOAuth.ts, lib/courseApi.ts's establishAuthSession): this is
 * "is this browser logged into Knovera," never a Whop credential.
 */

export class InvalidKnoveraCredentialsError extends Error {
  constructor(message = "Invalid email or password.") {
    super(message);
    this.name = "InvalidKnoveraCredentialsError";
  }
}

export interface KnoveraLoginResult {
  token: string;
  expiresIn: number;
}

export async function knoveraLogin(backendUrl: string, email: string, password: string): Promise<KnoveraLoginResult> {
  const res = await fetch(`${backendUrl}/api/knovera-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) throw new InvalidKnoveraCredentialsError();
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `Login failed (${res.status}).`);
  }
  return (await res.json()) as KnoveraLoginResult;
}

export interface KnoveraMe {
  authenticated: boolean;
  email: string;
}

/** Returns null (rather than throwing) on an invalid/expired token — this is the intended way to check "is my stored token still good," not an error case. */
export async function getKnoveraMe(backendUrl: string, knoveraToken: string): Promise<KnoveraMe | null> {
  const res = await fetch(`${backendUrl}/api/knovera-auth/me`, {
    headers: { Authorization: `Bearer ${knoveraToken}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Failed to verify Knovera session (${res.status}).`);
  return (await res.json()) as KnoveraMe;
}

/** Best-effort only — see the backend route's own comment: this is a stateless token, so logout cannot revoke it server-side. The caller must also discard the token locally (see knoveraSession.ts). */
export async function knoveraLogout(backendUrl: string, knoveraToken: string): Promise<void> {
  await fetch(`${backendUrl}/api/knovera-auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${knoveraToken}` },
  }).catch(() => undefined);
}
