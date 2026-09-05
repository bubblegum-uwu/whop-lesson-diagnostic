/**
 * The one Scarface course this frontend targets, plus Whop OAuth client
 * configuration — one typed module instead of scattering these identifiers
 * and env reads across components.
 */
export const SCARFACE_COURSE = {
  courseId: "cors_4lb7N3oassoZwHJvrufOYy",
  experienceId: "exp_gdmood6JIzSsE7",
  slug: "scarface-trades-mastermind",
} as const;

/**
 * The Whop OAuth client_id — public configuration, not a secret, set at
 * build time via `VITE_WHOP_CLIENT_ID`. Returns null when unconfigured so
 * callers can show "Whop OAuth is not configured." instead of prompting
 * the user to type one in.
 */
export function getWhopClientId(): string | null {
  const clientId = import.meta.env.VITE_WHOP_CLIENT_ID;
  return typeof clientId === "string" && clientId.length > 0 ? clientId : null;
}
