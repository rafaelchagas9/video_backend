import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { env } from "@/config/env";

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot.length === 0 ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export function isDemoAssetPath(value: unknown, cwd = process.cwd()): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const root = resolve(cwd, env.DEMO_ASSETS_DIR);
  const target = resolve(cwd, value);
  return isContained(root, target) && target !== root;
}

export function resolveDemoAssetPath(
  value: string,
  options: { mustExist?: boolean } = {}
): string {
  const root = resolve(process.cwd(), env.DEMO_ASSETS_DIR);
  const target = resolve(process.cwd(), value);
  if (!isContained(root, target) || target === root) {
    throw new Error(`Demo asset path escapes ${env.DEMO_ASSETS_DIR}: ${value}`);
  }

  const mustExist = options.mustExist ?? true;
  if (mustExist && !existsSync(target)) {
    throw new Error(`Demo asset does not exist: ${value}`);
  }

  if (existsSync(target)) {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!isContained(realRoot, realTarget) || realTarget === realRoot) {
      throw new Error(
        `Demo asset symlink escapes ${env.DEMO_ASSETS_DIR}: ${value}`
      );
    }
    // Preserve the configured assets-root path in service contracts. The
    // real paths above are used only to prove that a symlink cannot escape
    // the root; leaking the resolved target would make valid mounted/symlinked
    // demo roots fail the same containment checks at their consumers.
    return target;
  }

  const existingParent = dirname(target);
  if (existsSync(existingParent)) {
    const realRoot = realpathSync(root);
    const realParent = realpathSync(existingParent);
    if (!isContained(realRoot, realParent)) {
      throw new Error(
        `Demo asset parent escapes ${env.DEMO_ASSETS_DIR}: ${value}`
      );
    }
  }
  return target;
}

export function assertDemoAssetPath(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || !isDemoAssetPath(value)) {
    throw new Error(
      `Demo asset path escapes ${env.DEMO_ASSETS_DIR} for ${label}`
    );
  }
  resolveDemoAssetPath(value);
}

/**
 * Delete a generated demo file only when its configured path is contained by
 * the reserved runtime subtree. Seeded assets elsewhere under the demo root
 * are deliberately left untouched.
 */
export function removeDemoRuntimeAsset(
  value: string | null | undefined
): boolean {
  if (!value) return false;
  const target = resolveDemoAssetPath(value, { mustExist: false });
  const runtimeRoot = resolve(process.cwd(), env.DEMO_ASSETS_DIR, "runtime");
  if (!isContained(runtimeRoot, target) || target === runtimeRoot) return false;
  if (!existsSync(target) || !existsSync(runtimeRoot)) return false;

  const assetRoot = resolve(process.cwd(), env.DEMO_ASSETS_DIR);
  const expectedRuntimeRoot = resolve(realpathSync(assetRoot), "runtime");
  const realRuntimeRoot = realpathSync(runtimeRoot);
  if (realRuntimeRoot !== expectedRuntimeRoot) return false;

  // Unlinking a leaf symlink cannot remove its target. For regular files,
  // require physical containment too so a symlinked parent directory cannot
  // redirect a runtime-looking path into the seeded tree.
  if (
    !lstatSync(target).isSymbolicLink() &&
    !isContained(realRuntimeRoot, realpathSync(target))
  ) {
    return false;
  }
  unlinkSync(target);
  return true;
}

/**
 * Remove only generated demo assets. Seeded media elsewhere under the demo
 * assets root is deliberately preserved.
 */
export function resetDemoRuntimeAssets(): void {
  const runtimePath = resolveDemoAssetPath(
    join(env.DEMO_ASSETS_DIR, "runtime"),
    { mustExist: false }
  );
  rmSync(runtimePath, { recursive: true, force: true });
}
