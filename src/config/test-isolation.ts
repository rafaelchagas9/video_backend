import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const registeredRoots = new Set<string>();

function inside(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

function canonicalPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(existing), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Test-mode storage access refused: unresolved symbolic link");
      }
      missing.push(basename(existing));
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

/** Explicitly authorize an existing disposable fixture directory, never /tmp itself. */
export function registerTestStorageRoot(root: string): () => void {
  const canonical = realpathSync(root);
  const temporaryRoot = realpathSync(tmpdir());
  if (canonical === temporaryRoot || !inside(canonical, temporaryRoot)) {
    throw new Error("Test storage root must be a disposable directory inside the system temporary directory");
  }
  registeredRoots.add(canonical);
  return () => registeredRoots.delete(canonical);
}

export function assertSafeTestStoragePath(path: string, runtimeNodeEnv: string | undefined): void {
  if (runtimeNodeEnv !== "test") return;
  const roots = [...registeredRoots];
  const runnerRoot = process.env.TEST_STORAGE_ROOT;
  if (runnerRoot) {
    const canonical = realpathSync(runnerRoot);
    const temporaryRoot = realpathSync(tmpdir());
    if (inside(canonical, temporaryRoot) && basename(canonical).startsWith("conversor-video-test-")) roots.push(canonical);
  }
  const canonical = canonicalPath(path);
  if (!roots.some((root) => inside(canonical, root) && canonical !== root)) {
    throw new Error("Test-mode storage access refused: the path is outside an explicitly isolated fixture root");
  }
}

/** Production singleton clients remain unusable in tests; inject a fake instead. */
export function guardDefaultQueueClient<T extends object>(client: T, getRuntimeNodeEnv: () => string | undefined): T {
  return new Proxy(client, {
    get(target, property) {
      if (getRuntimeNodeEnv() === "test") {
        throw new Error("Test-mode default Redis access refused: inject an isolated fake queue client");
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
