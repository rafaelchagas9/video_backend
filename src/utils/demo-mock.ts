/**
 * Backward-compatible import path for feature services during the SQLite
 * migration. New code should import from `@/database/demo` directly.
 */
export {
  DemoRepository as DemoMockService,
  demoRepository as demoMockService,
} from "@/database/demo/repository";
export { isDemoAssetPath } from "@/database/demo/assets";
