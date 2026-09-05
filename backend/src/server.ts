import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { globalRedactor } from "./lib/redact.js";
import { logger } from "./lib/logger.js";

const config = loadConfig();

// Register long-lived secrets with the redactor as early as possible so
// they're never accidentally logged, even by a stray console.log elsewhere.
globalRedactor.register(config.geminiApiKey);
globalRedactor.register(config.db.password);
globalRedactor.register(config.refreshTokenEncryptionKey);

const app = createApp(config);

app.listen(config.port, () => {
  logger.info(`Backend listening on port ${config.port}`, {
    allowedOrigin: config.allowedOrigin,
    geminiModel: config.geminiModel,
  });
});
