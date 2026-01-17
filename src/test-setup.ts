import { beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { resolve } from "path";

const TEST_DB_PATH = resolve(process.cwd(), "data/test-database.db");

// Set test environment
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.SESSION_SECRET =
  "test-secret-key-for-testing-purposes-only-do-not-use-in-production";

beforeAll(() => {
  console.log("🧪 Test setup: Using test database");
});

afterAll(() => {
  // Clean up test database after all tests
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
    console.log("🧹 Test cleanup: Removed test database");
  }
});
