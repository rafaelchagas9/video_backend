import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeTestStoragePath, guardDefaultQueueClient, registerTestStorageRoot } from "@/config/test-isolation";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "storage-guard-fixture-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("test storage isolation", () => {
  it("allows an explicit fixture child but refuses real-looking temporary siblings", () => {
    const isolated = fixture();
    const realLookingLibrary = fixture();
    cleanup.push(registerTestStorageRoot(isolated));
    expect(() => assertSafeTestStoragePath(join(isolated, "cast", "session"), "test")).not.toThrow();
    expect(() => assertSafeTestStoragePath(join(realLookingLibrary, "cast"), "test")).toThrow("storage access refused");
    expect(() => assertSafeTestStoragePath(isolated, "test")).toThrow("storage access refused");
    expect(() => assertSafeTestStoragePath(join(isolated, "..", "private-library"), "test")).toThrow("storage access refused");
  });

  it("refuses symlink escapes, including missing targets", () => {
    const isolated = fixture();
    const sibling = fixture();
    cleanup.push(registerTestStorageRoot(isolated));
    mkdirSync(join(sibling, "cache"));
    symlinkSync(join(sibling, "cache"), join(isolated, "escape"));
    symlinkSync(join(sibling, "missing"), join(isolated, "dangling"));
    expect(() => assertSafeTestStoragePath(join(isolated, "escape", "session"), "test")).toThrow("storage access refused");
    expect(() => assertSafeTestStoragePath(join(isolated, "dangling", "session"), "test")).toThrow("storage access refused");
  });

  it("does not alter production paths and refuses broad fixture registration", () => {
    expect(() => assertSafeTestStoragePath("/srv/media/cast", "production")).not.toThrow();
    expect(() => registerTestStorageRoot(tmpdir())).toThrow("disposable directory");
  });
});

describe("default queue client isolation", () => {
  it("refuses inherited clients at use time without invoking them", () => {
    let calls = 0;
    let runtime = "production";
    const guarded = guardDefaultQueueClient({ send() { calls++; return "ok"; } }, () => runtime);
    runtime = "test";
    expect(() => guarded.send()).toThrow("default Redis access refused");
    expect(calls).toBe(0);
    runtime = "production";
    expect(guarded.send()).toBe("ok");
    expect(calls).toBe(1);
  });

  it("preserves receiver binding outside tests", () => {
    const guarded = guardDefaultQueueClient({ value: 42, send() { return this.value; } }, () => "production");
    expect(guarded.send()).toBe(42);
  });
});
