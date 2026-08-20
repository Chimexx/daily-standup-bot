import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root (`daily-standup-bot/`). */
export const PROJECT_ROOT = join(__dirname, "..");

/** Example / template config files (committed). */
export const CONFIG_EXAMPLES_DIR = join(PROJECT_ROOT, "config", "examples");

/**
 * Resolve a path relative to the project root, or return absolute paths unchanged.
 * @param {string | undefined} relativeOrAbsolute
 * @param {string} [defaultRelative]
 */
export function resolveProjectPath(relativeOrAbsolute, defaultRelative = "") {
  const raw = (relativeOrAbsolute ?? defaultRelative).trim();
  if (!raw) {
    return join(PROJECT_ROOT, defaultRelative);
  }
  return raw.startsWith("/") ? raw : join(PROJECT_ROOT, raw);
}

/**
 * Resolve an optional env override or a default file under the project root.
 * @param {string | undefined} envValue
 * @param {string} defaultRelative
 */
export function resolveEnvPath(envValue, defaultRelative) {
  return resolveProjectPath(envValue, defaultRelative);
}
