/**
 * The Phase 2 backend URL (Cloud Run service). Configured at build time via
 * VITE_BACKEND_URL. Not a secret — it's just an endpoint address.
 */
export function getBackendUrl(): string | null {
  const url = import.meta.env.VITE_BACKEND_URL;
  return typeof url === "string" && url.length > 0 ? url.replace(/\/$/, "") : null;
}
