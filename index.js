// Wispbyte JS_FILE entry point. Environment variables from the panel take precedence.
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
await import("./src/server.js");
