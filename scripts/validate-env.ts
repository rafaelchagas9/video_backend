#!/usr/bin/env bun
import { env } from "../src/config/env";

// Importing env applies the same validation as server startup.
if (env.SESSION_SECRET === "change-this-to-a-random-secret-in-production") {
  console.error(
    "Change the default SESSION_SECRET before starting the server."
  );
  process.exit(1);
}

console.log("Environment validation passed.");
console.log(`NODE_ENV: ${env.NODE_ENV}`);
console.log(`Server: ${env.HOST}:${env.PORT}`);
console.log(`Database: ${env.DEMO_MODE ? "demo SQLite" : "PostgreSQL"}`);
console.log(
  `PostHog: ${env.POSTHOG_API_KEY.length > 0 ? "enabled" : "disabled"}`
);
