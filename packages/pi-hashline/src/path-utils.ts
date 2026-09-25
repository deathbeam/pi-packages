import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveToCwd(filePath: string, cwd: string): string {
    const normalized = filePath.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
    const path = normalized.startsWith("file://") ? fileURLToPath(normalized) : normalized;
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    return resolve(cwd, expanded);
}
