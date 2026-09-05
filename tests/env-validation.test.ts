import { describe, expect, it } from "bun:test";

async function validateEnvironment(overrides: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "scripts/validate-env.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      POSTGRES_USER: "test_user",
      POSTGRES_PASSWORD: "private-test-password",
      SESSION_SECRET: "private-test-session-secret-at-least-32-characters",
      POSTHOG_API_KEY: "",
      CONTENT_ANALYSIS_MAX_RETRIES: "3",
      DEMO_MODE: "true",
      DEMO_RESET_MODE: "manual",
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("environment validation command", () => {
  it("validates demo configuration without displaying credentials", async () => {
    const result = await validateEnvironment();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("demo SQLite");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("private-test-");
  });

  it.each([
    ["CONTENT_ANALYSIS_MAX_RETRIES", "-1"],
    ["DEMO_RESET_MODE", "invalid"],
  ])("rejects invalid %s using the runtime schema", async (key, value) => {
    const result = await validateEnvironment({ [key]: value });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(key);
    expect(result.stdout).not.toContain("validation passed");
  });

  it("continues to reject the placeholder session secret", async () => {
    const result = await validateEnvironment({
      SESSION_SECRET: "change-this-to-a-random-secret-in-production",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Change the default SESSION_SECRET");
  });
});
