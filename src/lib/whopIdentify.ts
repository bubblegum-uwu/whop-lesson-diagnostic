/**
 * One-time setup helper: calls Whop's own documented userinfo endpoint
 * DIRECTLY from the browser, using the access token the user's own
 * just-completed OAuth sign-in produced. This never touches our backend —
 * it works even before the backend is deployed or before
 * WHOP_OPERATOR_USER_ID is configured, which is the whole point (that
 * variable has to come from *somewhere*, and it can't come from asking the
 * operator to paste a token into GitHub or a config file).
 *
 * The returned `sub` is a Whop account identifier, not a credential — it's
 * the same value already shown, non-sensitively, by GET /api/auth/status.
 * It is only ever displayed here for the operator to copy into their own
 * deployment configuration; nothing on this page sends it anywhere.
 */

export const WHOP_USERINFO_URL = "https://api.whop.com/oauth/userinfo";

export interface WhopUserInfo {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
}

export class WhopIdentifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopIdentifyError";
  }
}

export async function fetchWhopUserInfo(accessToken: string): Promise<WhopUserInfo> {
  const res = await fetch(WHOP_USERINFO_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new WhopIdentifyError(`Could not verify your identity with Whop (${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<WhopUserInfo>;
  if (typeof body.sub !== "string" || body.sub.length === 0) {
    throw new WhopIdentifyError("Whop's response did not include a user id.");
  }
  return body as WhopUserInfo;
}
