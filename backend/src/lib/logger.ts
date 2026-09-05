import { globalRedactor, type SecretRedactor } from "./redact.js";

/**
 * A logger that redacts every argument (via the provided SecretRedactor)
 * before writing to stdout/stderr. This is the ONLY logging surface the
 * rest of the backend should use — never call console.* directly in
 * request-handling code.
 */
export interface SafeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function stringifyMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  try {
    return " " + JSON.stringify(meta);
  } catch {
    return " [unserializable meta]";
  }
}

export function createSafeLogger(redactor: SecretRedactor = globalRedactor): SafeLogger {
  function write(
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) {
    const raw = `[${level.toUpperCase()}] ${message}${stringifyMeta(meta)}`;
    const safe = redactor.redact(raw);
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(safe);
    } else if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(safe);
    } else {
      // eslint-disable-next-line no-console
      console.log(safe);
    }
  }

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

export const logger = createSafeLogger();
