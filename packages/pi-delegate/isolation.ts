import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Persisted with the job: where the clone lives and which main-tree snapshot it started from. */
export type IsolationState = { clone: string; base: string };

type ApplyResult =
    | { kind: "applied"; stat: string; diff: string }
    | { kind: "empty" }
    | { kind: "conflict"; files: string[]; snapshot: string };

const IDENTITY = ["-c", "user.name=pi-delegate", "-c", "user.email=pi-delegate@localhost"];
const SNAPSHOT_BRANCH = "main-snapshot";

/** One git invocation; `indexFile` swaps in a scratch index and `input` feeds stdin (patches). */
function git(
    args: string[],
    options: { cwd?: string; gitDir?: string; workTree?: string; input?: string; indexFile?: string } = {},
): string {
    const command = [
        ...(options.gitDir ? ["--git-dir", options.gitDir] : []),
        ...(options.workTree ? ["--work-tree", options.workTree] : []),
        ...args,
    ];
    try {
        return execFileSync("git", command, {
            cwd: options.cwd,
            input: options.input,
            encoding: "utf8",
            // Without this, git's stderr (rebase hints etc.) leaks onto the TUI.
            stdio: "pipe",
            // Binary diffs of real repositories blow past execFileSync's 1 MiB default.
            maxBuffer: 1024 ** 3,
            env: options.indexFile ? { ...process.env, GIT_INDEX_FILE: options.indexFile } : process.env,
        });
    } catch (error) {
        const failure = error as { stderr?: string };
        const detail = (failure.stderr ?? "").trim();
        throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
    }
}

/** Clones live at <repoRoot>/.pi/worktrees/<jobId>, so the root sits three directories up. */
function rootOf(iso: IsolationState): string {
    return resolve(iso.clone, "..", "..", "..");
}

/**
 * Commits the main tree's current content (committed, uncommitted, and untracked files, honoring
 * .gitignore) with the recorded base as parent, through a scratch index so the clone's own checkout
 * and index stay untouched. Updates and returns the `main-snapshot` branch.
 */
function snapshotMainTree(iso: IsolationState, root: string): string {
    const gitDir = join(iso.clone, ".git");
    const indexFile = join(gitDir, "pi-delegate-snapshot-index");
    try {
        git(["read-tree", iso.base], { gitDir, indexFile });
        git(["add", "-A"], { gitDir, workTree: root, indexFile });
        const tree = git(["write-tree"], { gitDir, indexFile }).trim();
        const snapshot = git([...IDENTITY, "commit-tree", tree, "-p", iso.base, "-m", "main tree snapshot"], {
            gitDir,
        }).trim();
        git(["branch", "-f", SNAPSHOT_BRANCH, snapshot], { gitDir });
        return snapshot;
    } finally {
        rmSync(indexFile, { force: true });
    }
}

/** Creates the isolated clone and the base commit capturing the main tree as the user sees it now. */
export function createIsolation(cwd: string, jobId: string): IsolationState {
    let root: string;
    try {
        root = git(["rev-parse", "--show-toplevel"], { cwd }).trim();
    } catch {
        throw new Error("isolated: true requires the session to run inside a git repository.");
    }
    const clone = join(root, ".pi", "worktrees", jobId);
    rmSync(clone, { recursive: true, force: true });
    git(["clone", "--shared", "--quiet", root, clone]);
    try {
        // Snapshots use --work-tree=<root>, so the clones themselves must never be picked up; the
        // main repo's local excludes must carry over too, or locally-ignored files land in clones.
        let exclude = "\n.pi/worktrees/\n";
        try {
            const mainExclude = git(["rev-parse", "--git-path", "info/exclude"], { cwd: root }).trim();
            exclude = `${readFileSync(resolve(root, mainExclude), "utf8")}${exclude}`;
        } catch {
            // No local exclude file; .gitignore still applies.
        }
        writeFileSync(join(clone, ".git", "info", "exclude"), exclude);
        let head: string;
        try {
            head = git(["rev-parse", "HEAD"], { cwd: clone }).trim();
        } catch {
            throw new Error("cannot isolate a repository with no commits.");
        }
        const iso: IsolationState = { clone, base: head };
        iso.base = snapshotMainTree(iso, root);
        // The clone's checkout still matches the upstream tip; make it match the snapshot instead.
        git(["reset", "--hard", "--quiet", iso.base], { cwd: clone });
        return iso;
    } catch (error) {
        rmSync(clone, { recursive: true, force: true });
        throw error;
    }
}

/** The clone path matching the session cwd's position inside the repository. */
export function cloneCwd(iso: IsolationState, cwd: string): string {
    const rel = relative(rootOf(iso), cwd);
    return rel.startsWith("..") ? iso.clone : join(iso.clone, rel);
}

/** Clone location plus a stat of everything the delegate changed, for the job's report. */
export function isolationSummary(iso: IsolationState): string {
    const lines = [`Isolated clone: ${iso.clone}`];
    try {
        // Staging first pulls uncommitted and untracked changes into the stat.
        git(["add", "-A"], { cwd: iso.clone });
        const stat = git(["diff", "--stat", iso.base], { cwd: iso.clone }).trimEnd();
        if (stat) lines.push(`Changes in this clone:\n${stat}`);
    } catch {
        // The clone may already be applied or gone; the path alone still says where the work lives.
    }
    return lines.join("\n");
}

export function removeClone(iso: IsolationState): void {
    rmSync(iso.clone, { recursive: true, force: true });
}

/**
 * Merges the delegate's clone into the main working tree. Base rule: `base` always tracks the newest
 * `main-snapshot`, so a repeat apply is correct whether or not the delegate rebased onto it yet.
 * The main repository's .git is never written to; only its working tree receives the final patch.
 */
export function applyClone(iso: IsolationState): ApplyResult {
    const root = rootOf(iso);
    const run = (args: string[]) => git(args, { cwd: iso.clone });
    // Commit uncommitted delegate work so the rebase carries it.
    run(["add", "-A"]);
    if (run(["status", "--porcelain"]).trim()) run([...IDENTITY, "commit", "--no-verify", "-m", "delegate work"]);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (branch === SNAPSHOT_BRANCH)
        throw new Error(
            `the clone is checked out on ${SNAPSHOT_BRANCH}; steer the delegate to move its work onto its own branch, then apply again`,
        );
    // Snapshot the current main tree, then replay the delegate's commits onto it with a real 3-way
    // merge: git tolerates nearby, non-overlapping edits that raw patch context matching rejects.
    const snapshot = snapshotMainTree(iso, root);
    try {
        run([...IDENTITY, "rebase", "--empty=drop", SNAPSHOT_BRANCH]);
    } catch (error) {
        const files = run(["diff", "--name-only", "--diff-filter=U"]).trim();
        try {
            run(["rebase", "--abort"]);
        } catch {
            // The rebase failed before starting; there is nothing to abort.
        }
        // A real conflict leaves unmerged files; anything else (e.g. a missing git identity) surfaces as-is.
        if (!files) throw error;
        return { kind: "conflict", files: files.split("\n"), snapshot };
    }
    // After the rebase this diff is exactly the delegate's work on the current main state.
    const patch = run(["diff", "--binary", SNAPSHOT_BRANCH, "HEAD"]);
    if (!patch.trim()) return { kind: "empty" };
    // A changed submodule serializes as a "Subproject commit" hunk that git apply rejects outright.
    if (run(["diff", "--raw", SNAPSHOT_BRANCH, "HEAD"]).match(/^:160000 160000 /m))
        throw new Error("the delegate changed a submodule (gitlink), which git apply cannot carry; apply it manually");
    try {
        git(["apply", "--check", "-"], { cwd: root, input: patch });
    } catch (error) {
        // The patch was built on the exact snapshot, so a rejection means the tree moved after it.
        throw new Error(
            `${(error as Error).message} — the main tree changed since the snapshot; call delegate_apply again`,
        );
    }
    git(["apply", "-"], { cwd: root, input: patch });
    // Without --binary, binary files render as a name-only "Binary files differ" line.
    return {
        kind: "applied",
        stat: run(["diff", "--stat", SNAPSHOT_BRANCH, "HEAD"]).trimEnd(),
        diff: run(["diff", SNAPSHOT_BRANCH, "HEAD"]),
    };
}
