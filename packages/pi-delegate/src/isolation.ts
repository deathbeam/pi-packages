import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

/** Persisted with the job: where the clone lives and which main-tree snapshot it started from. */
export type IsolationState = { clone: string; base: string };

type ApplyResult =
    | { kind: "applied"; stat: string; diff: string }
    | { kind: "empty" }
    | { kind: "conflict"; files: string[]; snapshot: string };

const IDENTITY = ["-c", "user.name=pi-delegate", "-c", "user.email=pi-delegate@localhost"];
const SNAPSHOT_BRANCH = "main-snapshot";
const execFileAsync = promisify(execFile);

/** One git invocation; `indexFile` swaps in a scratch index and `input` feeds stdin (patches). */
async function git(
    args: string[],
    options: {
        cwd?: string;
        gitDir?: string;
        workTree?: string;
        input?: string;
        indexFile?: string;
        signal?: AbortSignal;
    } = {},
): Promise<string> {
    const command = [
        ...(options.gitDir ? ["--git-dir", options.gitDir] : []),
        ...(options.workTree ? ["--work-tree", options.workTree] : []),
        ...args,
    ];
    const pending = execFileAsync("git", command, {
        cwd: options.cwd,
        encoding: "utf8",
        // Binary diffs of real repositories blow past execFile's 1 MiB default.
        maxBuffer: 1024 ** 3,
        signal: options.signal,
        env: options.indexFile ? { ...process.env, GIT_INDEX_FILE: options.indexFile } : process.env,
    });
    // The promisified form has no `input` option, so the patch rides stdin; closing it is also EOF for `git apply -`.
    // A git that exits before reading it (e.g. a rejected patch) would otherwise raise an uncaught EPIPE.
    pending.child.stdin?.on("error", () => {}).end(options.input);
    try {
        return (await pending).stdout;
    } catch (error) {
        // An aborted turn is not a git failure; pi marks the cancelled tool call itself.
        if (options.signal?.aborted) throw error;
        const failure = error as { stderr?: string };
        const detail = (failure.stderr ?? "").trim();
        throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
    }
}

/** Clones live at <repoRoot>/.pi/worktrees/<jobId>, so the root sits three directories up. */
function rootOf(iso: IsolationState): string {
    return resolve(iso.clone, "..", "..", "..");
}

/** Commits the main tree's current content through a scratch index, so the clone's own checkout and index stay untouched. */
async function snapshotMainTree(iso: IsolationState, root: string, signal?: AbortSignal): Promise<string> {
    const gitDir = join(iso.clone, ".git");
    const indexFile = join(gitDir, "pi-delegate-snapshot-index");
    try {
        await git(["read-tree", iso.base], { gitDir, indexFile, signal });
        await git(["add", "-A"], { gitDir, workTree: root, indexFile, signal });
        const tree = (await git(["write-tree"], { gitDir, indexFile, signal })).trim();
        const snapshot = (
            await git([...IDENTITY, "commit-tree", tree, "-p", iso.base, "-m", "main tree snapshot"], {
                gitDir,
                signal,
            })
        ).trim();
        await git(["branch", "-f", SNAPSHOT_BRANCH, snapshot], { gitDir, signal });
        return snapshot;
    } finally {
        await rm(indexFile, { force: true });
    }
}

/** Creates the isolated clone and the base commit capturing the main tree as the user sees it now. */
export async function createIsolation(cwd: string, jobId: string, signal?: AbortSignal): Promise<IsolationState> {
    let root: string;
    try {
        root = (await git(["rev-parse", "--show-toplevel"], { cwd, signal })).trim();
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("isolated: true requires the session to run inside a git repository.");
    }
    const clone = join(root, ".pi", "worktrees", jobId);
    await rm(clone, { recursive: true, force: true });
    try {
        await git(["clone", "--shared", "--quiet", root, clone], { signal });
        // Snapshots use --work-tree=<root>, so the clones themselves must never be picked up; the
        // main repo's local excludes must carry over too, or locally-ignored files land in clones.
        let exclude = "\n.pi/worktrees/\n";
        try {
            const mainExclude = (await git(["rev-parse", "--git-path", "info/exclude"], { cwd: root, signal })).trim();
            exclude = `${await readFile(resolve(root, mainExclude), "utf8")}${exclude}`;
        } catch {
            // No local exclude file; .gitignore still applies.
        }
        await writeFile(join(clone, ".git", "info", "exclude"), exclude);
        let head: string;
        try {
            head = (await git(["rev-parse", "HEAD"], { cwd: clone, signal })).trim();
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new Error("cannot isolate a repository with no commits.");
        }
        const iso: IsolationState = { clone, base: head };
        iso.base = await snapshotMainTree(iso, root, signal);
        // The clone's checkout still matches the upstream tip; make it match the snapshot instead.
        await git(["reset", "--hard", "--quiet", iso.base], { cwd: clone, signal });
        return iso;
    } catch (error) {
        await rm(clone, { recursive: true, force: true });
        throw error;
    }
}

/** The clone path matching the session cwd's position inside the repository. */
export function cloneCwd(iso: IsolationState, cwd: string): string {
    const rel = relative(rootOf(iso), cwd);
    return rel.startsWith("..") ? iso.clone : join(iso.clone, rel);
}

/** Clone location plus a stat of everything the delegate changed, for the job's report. */
export async function isolationSummary(iso: IsolationState, signal?: AbortSignal): Promise<string> {
    const lines = [`Isolated clone: ${iso.clone}`];
    const indexFile = join(iso.clone, ".git", "pi-delegate-summary-index");
    try {
        // A scratch index stages uncommitted and untracked changes for the stat without touching the clone's own index.
        await git(["read-tree", "HEAD"], { cwd: iso.clone, indexFile, signal });
        await git(["add", "-A"], { cwd: iso.clone, indexFile, signal });
        const stat = (await git(["diff", "--stat", iso.base], { cwd: iso.clone, indexFile, signal })).trimEnd();
        if (stat) lines.push(`Changes in this clone:\n${stat}`);
    } catch {
        // The clone may already be applied or gone; the path alone still says where the work lives.
    } finally {
        await rm(indexFile, { force: true });
    }
    return lines.join("\n");
}

export async function removeClone(iso: IsolationState): Promise<void> {
    await rm(iso.clone, { recursive: true, force: true });
}

/**
 * Merges the clone into the main working tree. Base rule: `base` tracks the newest `main-snapshot`, so a
 * repeat apply is correct whether or not the delegate rebased onto it yet. Only the main tree is written.
 */
export async function applyClone(iso: IsolationState): Promise<ApplyResult> {
    const root = rootOf(iso);
    function run(args: string[]): Promise<string> {
        return git(args, { cwd: iso.clone });
    }
    // Commit uncommitted delegate work so the rebase carries it.
    await run(["add", "-A"]);
    if ((await run(["status", "--porcelain"])).trim())
        await run([...IDENTITY, "commit", "--no-verify", "-m", "delegate work"]);
    const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch === SNAPSHOT_BRANCH)
        throw new Error(
            `the clone is checked out on ${SNAPSHOT_BRANCH}; steer the delegate to move its work onto its own branch, then apply again`,
        );
    // Snapshot the current main tree, then replay the delegate's commits onto it with a real 3-way
    // merge: git tolerates nearby, non-overlapping edits that raw patch context matching rejects.
    const snapshot = await snapshotMainTree(iso, root);
    try {
        await run([...IDENTITY, "rebase", "--empty=drop", SNAPSHOT_BRANCH]);
    } catch (error) {
        const files = (await run(["diff", "--name-only", "--diff-filter=U"])).trim();
        try {
            await run(["rebase", "--abort"]);
        } catch {
            // The rebase failed before starting; there is nothing to abort.
        }
        // A real conflict leaves unmerged files; anything else (e.g. a missing git identity) surfaces as-is.
        if (!files) throw error;
        return { kind: "conflict", files: files.split("\n"), snapshot };
    }
    // After the rebase this diff is exactly the delegate's work on the current main state.
    const patch = await run(["diff", "--binary", SNAPSHOT_BRANCH, "HEAD"]);
    if (!patch.trim()) return { kind: "empty" };
    // A changed submodule serializes as a "Subproject commit" hunk that git apply rejects outright.
    if ((await run(["diff", "--raw", SNAPSHOT_BRANCH, "HEAD"])).match(/^:160000 160000 /m))
        throw new Error("the delegate changed a submodule (gitlink), which git apply cannot carry; apply it manually");
    try {
        await git(["apply", "--check", "-"], { cwd: root, input: patch });
    } catch (error) {
        // The patch was built on the exact snapshot, so a rejection means the tree moved after it.
        throw new Error(
            `${(error as Error).message} — the main tree changed since the snapshot; call delegate_apply again`,
        );
    }
    await git(["apply", "-"], { cwd: root, input: patch });
    // Without --binary, binary files render as a name-only "Binary files differ" line.
    return {
        kind: "applied",
        stat: (await run(["diff", "--stat", SNAPSHOT_BRANCH, "HEAD"])).trimEnd(),
        diff: await run(["diff", SNAPSHOT_BRANCH, "HEAD"]),
    };
}
