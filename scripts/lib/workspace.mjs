import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the workspace root by walking up from cwd looking for a git root.
 * Falls back to cwd if no git root found.
 */
export function resolveWorkspaceRoot(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.resolve(cwd);
}
