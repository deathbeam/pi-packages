import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

/** Temp dir that cleanupTempDirs() removes. */
export function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

export function cleanupTempDirs(): void {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

/** Writes `<cwd>/.pi/settings.json` with the given `images` settings. */
export function writeSettings(cwd: string, images: unknown): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ images }));
}

// Every test file imports this module first, so HOME already points at an empty temp dir when the
// extension loads and no settings from the host leak into readImagesSettings().
process.env.HOME = tempDir("pi-images-home-");
