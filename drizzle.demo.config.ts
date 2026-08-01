import type { Config } from "drizzle-kit";

export default {
  schema: "./src/database/demo/schema.ts",
  out: "./src/database/demo/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DEMO_DATABASE_PATH || "./demo_mode/demo.sqlite",
  },
  verbose: true,
  strict: true,
} satisfies Config;
