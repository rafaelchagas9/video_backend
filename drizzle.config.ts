import type { Config } from "drizzle-kit";
import { env } from "./src/config/env";

export default {
  schema: "./src/database/schema/index.ts",
  out: "./src/database/drizzle-migrations",
  dialect: "postgresql",
  dbCredentials: {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
    ssl: false,
  },
  verbose: true,
  strict: true,
} satisfies Config;
