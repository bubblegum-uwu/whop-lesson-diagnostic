import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Several new tests exercise the real local Postgres, including a
    // singleton auth_sessions row (by design — see the init-schema
    // migration). Running test files in parallel workers races against
    // that shared state, so files run sequentially instead; the suite is
    // small enough that this costs negligible time.
    fileParallelism: false,
  },
});
