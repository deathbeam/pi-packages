import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { applyClone, createIsolation, isolationSummary, removeClone } from "../src/isolation.ts";
import { cleanup, tempGitRepo } from "./helpers.ts";

afterAll(cleanup);

describe("createIsolation", () => {
    // Isolation snapshots the main tree as the user sees it: uncommitted and untracked work, but never .pi/worktrees.
    it("snapshots uncommitted work without the worktree clones", () => {
        const repo = tempGitRepo({ "tracked.txt": "one\n" });
        try {
            writeFileSync(join(repo.dir, "tracked.txt"), "two\n");
            writeFileSync(join(repo.dir, "untracked.txt"), "new\n");
            mkdirSync(join(repo.dir, ".pi", "worktrees", "junk"), { recursive: true });
            writeFileSync(join(repo.dir, ".pi", "worktrees", "junk", "secret.txt"), "no\n");
            const iso = createIsolation(repo.dir, "snap1");
            try {
                assert.equal(readFileSync(join(iso.clone, "tracked.txt"), "utf8"), "two\n", "uncommitted edit missing");
                assert.equal(readFileSync(join(iso.clone, "untracked.txt"), "utf8"), "new\n", "untracked file missing");
                assert.equal(
                    existsSync(join(iso.clone, ".pi", "worktrees", "junk", "secret.txt")),
                    false,
                    ".pi/worktrees leaked into the snapshot",
                );
                // The report stages through a scratch index, so it must not touch the clone's own index.
                writeFileSync(join(iso.clone, "later.txt"), "x\n");
                assert.match(isolationSummary(iso), /later\.txt/);
                assert.match(
                    execFileSync("git", ["status", "--porcelain"], { cwd: iso.clone, encoding: "utf8" }),
                    /^\?\? later\.txt$/m,
                    "isolationSummary staged into the clone's index",
                );
            } finally {
                removeClone(iso);
            }
        } finally {
            repo.remove();
        }
    });
});

describe("applyClone", () => {
    // A real conflict keeps the clone, aborts the rebase, and leaves the main tree untouched.
    it("reports a conflict and leaves the main tree untouched", () => {
        const repo = tempGitRepo({ "shared.txt": "base\n" });
        try {
            const iso = createIsolation(repo.dir, "conflict1");
            try {
                writeFileSync(join(iso.clone, "shared.txt"), "delegate\n");
                execFileSync(
                    "git",
                    ["-c", "user.name=delegate", "-c", "user.email=delegate@localhost", "commit", "-am", "delegate"],
                    { cwd: iso.clone },
                );
                writeFileSync(join(repo.dir, "shared.txt"), "main\n");
                const result = applyClone(iso);
                assert.equal(result.kind, "conflict");
                assert.deepEqual(result.files, ["shared.txt"]);
                assert.ok(result.snapshot);
                assert.equal(
                    readFileSync(join(repo.dir, "shared.txt"), "utf8"),
                    "main\n",
                    "conflict touched the main tree",
                );
                assert.equal(
                    execFileSync("git", ["status", "--porcelain"], { cwd: iso.clone, encoding: "utf8" }).trim(),
                    "",
                    "conflict left the clone mid-rebase",
                );
            } finally {
                removeClone(iso);
            }
        } finally {
            repo.remove();
        }
    });
});
