/* Self-check for pi-hashline: load the extension via jiti (as pi does) and exercise read/edit. Run: node check.mjs */
import { createJiti } from "jiti";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const jiti = createJiti(import.meta.url);
const mod = jiti("./index.ts");
// renderDiff reads pi's global theme singleton; initialize it headless.
const { initTheme } = jiti("@earendil-works/pi-coding-agent");
initTheme();

const registered = [];
const pi = {
    registerTool: (t) => registered.push(t),
    on: () => {},
};
mod.default(pi);

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
console.log("registered tools:", registered.map((t) => t.name).sort());
if (
    registered
        .map((t) => t.name)
        .sort()
        .join() !== "edit,grep,read"
) {
    throw new Error("expected read, edit, grep registered");
}

const dir = mkdtempSync(join(tmpdir(), "hashline-smoke-"));
const file = join(dir, "sample.ts");
writeFileSync(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");

const ctx = { cwd: dir };
const noop = () => {};

async function run(tool, params) {
    return tool.execute("id", params, undefined, noop, ctx);
}

(async () => {
    // 1. read: 3-char hashes, LINE#HASH:content, no space after colon
    const readResult = await run(byName.read, { path: file });
    const readText = readResult.content[0].text;
    console.log("--- read output ---");
    console.log(readText);
    if (!/^\s*1#[A-Z]{3}:const x = 1;$/m.test(readText)) {
        throw new Error("expected 3-char hash prefixes");
    }
    if (readResult.details.snapshotId !== undefined) {
        throw new Error("snapshotId should be gone");
    }

    // Pi path conventions are shared by read, edit and grep.
    const spaceFile = join(dir, "space name.ts");
    writeFileSync(spaceFile, "const path = 1;\n");
    const spaceRef = `@${spaceFile.replace(" ", "\u202f")}`;
    const spaceRead = await run(byName.read, { path: spaceRef });
    const spaceAnchor = spaceRead.content[0].text.match(/1#[A-Z]{3}/)?.[0];
    if (!spaceAnchor) throw new Error("read did not resolve Pi-style @/Unicode-space path");
    await run(byName.edit, {
        path: spaceRef,
        edits: [{ op: "replace", pos: spaceAnchor, lines: ["const path = 2;"] }],
    });
    const spaceGrep = await run(byName.grep, { pattern: "const path = 2;", path: spaceRef, literal: true });
    if (!/#[A-Z]{3}:const path = 2;/.test(spaceGrep.content[0].text)) {
        throw new Error("edit/grep did not resolve Pi-style @/Unicode-space path");
    }
    const urlRead = await run(byName.read, { path: pathToFileURL(spaceFile).href });
    if (!/#[A-Z]{3}:const path = 2;/.test(urlRead.content[0].text)) {
        throw new Error("read did not resolve Pi-style file URL");
    }
    console.log("--- shared Pi-style path resolution OK ---");

    // 2. edit: replace line 2 using the anchor from read output
    const anchor = readText.match(/^\s*2#([A-Z]{3}):/m);
    if (!anchor) throw new Error("no anchor for line 2");
    const editResult = await run(byName.edit, {
        path: file,
        edits: [{ op: "replace", pos: `2#${anchor[1]}`, lines: ["const y = 20;"] }],
    });
    console.log("--- edit result ---");
    console.log(editResult.content[0].text);
    const after = readFileSync(file, "utf8");
    if (after !== "const x = 1;\nconst y = 20;\nconst z = 3;\n") {
        throw new Error(`unexpected file content: ${JSON.stringify(after)}`);
    }

    // Shared-boundary append must follow the whole replacement.
    writeFileSync(file, "a\nb\nc\n");
    const orderRead = await run(byName.read, { path: file });
    const orderAnchor = orderRead.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    if (!orderAnchor) throw new Error("no anchor for the ordering check");
    await run(byName.edit, {
        path: file,
        edits: [
            { op: "replace", pos: `2#${orderAnchor[1]}`, lines: ["X", "Y"] },
            { op: "append", pos: `2#${orderAnchor[1]}`, lines: ["Z"] },
        ],
    });
    const ordered = readFileSync(file, "utf8");
    if (ordered !== "a\nX\nY\nZ\nc\n") {
        throw new Error("batched replace+append misordered: " + JSON.stringify(ordered));
    }
    console.log("--- batched replace+append ordering OK ---");

    // 3. Bug fix 1: anchor with " " after colon (hash matches) must NOT be stale
    writeFileSync(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");
    const reread = await run(byName.read, { path: file });
    const m = reread.content[0].text.match(/^\s*2#([A-Z]{3}):(.*)$/m);
    const hintedEdit = await run(byName.edit, {
        path: file,
        edits: [{ op: "replace", pos: `2#${m[1]}: ${m[2]}`, lines: ["const y = 222;"] }],
    });
    if (hintedEdit.isError !== undefined || /E_STALE_ANCHOR/.test(hintedEdit.content[0].text)) {
        throw new Error("bug1: hinted anchor wrongly rejected: " + hintedEdit.content[0].text);
    }
    console.log("--- bug1 (space after colon) OK ---");

    // A no-op must not claim that mixed line endings were rewritten.
    const endingsFile = join(dir, "endings.txt");
    const mixedEndings = "alpha\r\nbeta\n";
    writeFileSync(endingsFile, mixedEndings);
    const endingsRead = await run(byName.read, { path: endingsFile });
    const endingsAnchor = endingsRead.content[0].text.match(/1#[A-Z]{3}/)?.[0];
    if (!endingsAnchor) throw new Error("missing anchor for mixed-ending check");
    const endingsNoop = await run(byName.edit, {
        path: endingsFile,
        edits: [{ op: "replace", pos: endingsAnchor, lines: ["alpha"] }],
    });
    if (
        !endingsNoop.details.warnings.some((warning) => warning.startsWith("No changes made to ")) ||
        "classification" in endingsNoop.details ||
        /Classification: noop/.test(endingsNoop.content[0].text) ||
        readFileSync(endingsFile, "utf8") !== mixedEndings ||
        endingsNoop.details.warnings.some((warning) => /rewrote/.test(warning))
    ) {
        throw new Error("no-op incorrectly claimed to rewrite mixed line endings");
    }
    const endingsChanged = await run(byName.edit, {
        path: endingsFile,
        edits: [{ op: "replace", pos: endingsAnchor, lines: ["ALPHA"] }],
    });
    if (!endingsChanged.details.warnings.some((warning) => /rewrote/.test(warning))) {
        throw new Error("real edit lost its mixed-line-ending warning");
    }
    console.log("--- mixed-endings warning only on actual write OK ---");

    // 4. replace_text must fail with the teaching error
    try {
        await run(byName.edit, {
            path: file,
            edits: [{ op: "replace", pos: `2#${m[1]}`, oldText: "const y = 2;", newText: "nope" }],
        });
        throw new Error("expected replace_text to fail");
    } catch (e) {
        if (!/Text-replace edits are not supported/.test(e.message)) {
            throw new Error("wrong teaching error: " + e.message);
        }
        console.log("--- replace_text teaching error OK ---");
    }

    // 5. top-level oldText/newText fails in prepareArguments (pre-schema), like pi's agent loop
    try {
        byName.edit.prepareArguments({ path: file, oldText: "a", newText: "b" });
        throw new Error("expected top-level oldText to fail");
    } catch (e) {
        if (!/Text-replace edits are not supported/.test(e.message)) {
            throw new Error("wrong root teaching error: " + e.message);
        }
        console.log("--- top-level oldText teaching error OK (prepareArguments) ---");
    }

    // Lowercase anchors work; even lowercase numbered display prefixes are rejected.
    const lowerFile = join(dir, "lower.ts");
    writeFileSync(lowerFile, "const lower = 1;\nconst second = 2;\n");
    const lowerRead = await run(byName.read, { path: lowerFile });
    const lm = lowerRead.content[0].text.match(/^\s*1#([A-Z]{3}):/m);
    let lowerOutcome = "";
    try {
        const res = await run(byName.edit, {
            path: lowerFile,
            edits: [{ op: "replace", pos: `1#${lm[1].toLowerCase()}`, lines: ["const lower = 42;"] }],
        });
        lowerOutcome = res.content?.[0]?.text ?? "";
    } catch (e) {
        lowerOutcome = e.message;
    }
    if (!/42/.test(readFileSync(lowerFile, "utf8"))) {
        throw new Error("lowercase anchor rejected: " + lowerOutcome);
    }
    const lowerReread = await run(byName.read, { path: lowerFile });
    const lm2 = lowerReread.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    let prefixOutcome = "";
    try {
        const res = await run(byName.edit, {
            path: lowerFile,
            edits: [{ op: "replace", pos: `2#${lm2[1]}`, lines: [`1#${lm2[1].toLowerCase()}: const smuggled = 1;`] }],
        });
        prefixOutcome = res.content?.[0]?.text ?? "";
    } catch (e) {
        prefixOutcome = e.message;
    }
    if (!/E_INVALID_PATCH/.test(prefixOutcome) || /smuggled/.test(readFileSync(lowerFile, "utf8"))) {
        throw new Error("numbered display prefix not rejected: " + prefixOutcome);
    }
    const literals = ["# npm: install", "# TSX: notes", "- 12    indented"];
    const literalRead = await run(byName.read, { path: lowerFile });
    const lm3 = literalRead.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    await run(byName.edit, {
        path: lowerFile,
        edits: [{ op: "append", pos: `2#${lm3[1]}`, lines: literals }],
    });
    const literalFile = readFileSync(lowerFile, "utf8");
    for (const literal of literals) {
        if (!literalFile.includes(literal)) {
            throw new Error(`legitimate literal rejected: ${JSON.stringify(literal)}`);
        }
    }
    console.log("--- lowercase anchor OK; strict LINE#HASH rejection + literal shapes OK ---");

    // 6. raw read of a huge single line: no inverted range, no nextOffset
    const bigFile = join(dir, "big.txt");
    writeFileSync(bigFile, "x".repeat(60 * 1024));
    const big = await run(byName.read, { path: bigFile, raw: true });
    if (/lines 1-0/.test(big.content[0].text) || big.details.nextOffset !== undefined) {
        throw new Error("bug3: raw oversized line still broken: " + JSON.stringify(big));
    }
    console.log("--- bug3 (raw oversized line) OK:", JSON.stringify(big.content[0].text.slice(0, 80)));
    const nearCapFile = join(dir, "near-cap.txt");
    writeFileSync(nearCapFile, "x".repeat(50 * 1024 - 500));
    const nearCap = await run(byName.read, { path: nearCapFile });
    if (!/^1#[A-Z]{3}:x/m.test(nearCap.content[0].text) || nearCap.details.truncation?.firstLineExceedsLimit) {
        throw new Error("read did not use the full 50KB content budget");
    }

    // 6b. read caps before formatting, including a huge explicit limit; wide
    // continuation anchors still hash against the complete file.
    const wideFile = join(dir, "wide.txt");
    writeFileSync(
        wideFile,
        Array.from({ length: 2201 }, (_, i) => `const wide_${i} = "${"x".repeat(40)}";`).join("\n") + "\n",
    );
    const wideRead = await run(byName.read, { path: wideFile, limit: 100000 });
    const wideText = wideRead.content[0].text;
    const wideNotice = wideText.match(/Use offset=(\d+) to continue/);
    const wideAnchorLines = wideText.split("\n").filter((line) => /^\s*\d+#[A-Z]{3}:/.test(line));
    if (!wideNotice || wideRead.details.nextOffset !== Number(wideNotice[1]) || wideAnchorLines.length > 2000) {
        throw new Error("wide read did not cap with a stable continuation offset");
    }
    if (Buffer.byteLength(wideText.split("\n\n[Showing lines ")[0], "utf8") > 50 * 1024) {
        throw new Error("wide read content exceeded the 50KB cap");
    }
    const wideContinuation = await run(byName.read, { path: wideFile, offset: wideRead.details.nextOffset });
    const wideAnchor = wideContinuation.content[0].text.match(/^\s*\d+#([A-Z]{3}):/m);
    if (!wideAnchor) throw new Error("wide continuation missing an anchor");
    await run(byName.edit, {
        path: wideFile,
        edits: [
            {
                op: "replace",
                pos: `${wideRead.details.nextOffset}#${wideAnchor[1]}`,
                lines: ["const continued = true;"],
            },
        ],
    });
    console.log("--- read cap + wide continuation hash OK ---");

    // 7. grep smoke (if rg present)
    if (byName.grep) {
        const grepResult = await run(byName.grep, { pattern: "const y", path: dir, glob: "*.ts" });
        console.log("--- grep output ---");
        console.log(grepResult.content[0].text);
        if (!/#[A-Z]{3}:const y/.test(grepResult.content[0].text)) {
            throw new Error("grep output missing 3-char anchors");
        }

        // A whole-line anchor cannot fit for a huge line; report it rather than hiding the match.
        const longMatchFile = join(dir, "long-match.txt");
        writeFileSync(longMatchFile, `oversized ${"x".repeat(60 * 1024)}\noversized short\n`);
        const longMatch = await run(byName.grep, { pattern: "oversized", path: longMatchFile });
        const longMatchText = longMatch.content[0].text;
        if (
            !/Line 1 cannot fit.*\(match\)/.test(longMatchText) ||
            !/^2#[A-Z]{3}:oversized short$/m.test(longMatchText) ||
            longMatch.details.truncated !== true ||
            !longMatch.details.noticeCount
        ) {
            throw new Error("grep hid a match on a line too large to anchor: " + longMatchText.slice(0, 200));
        }
        console.log("--- grep oversized match remains visible as a warning OK ---");

        // When a full anchor would exceed the remaining budget, show a placeholder and keep scanning.
        const budgetFile = join(dir, "budget-match.txt");
        writeFileSync(budgetFile, `budget ${"a".repeat(26 * 1024)}\nbudget ${"b".repeat(26 * 1024)}\nbudget short\n`);
        const budgetMatch = await run(byName.grep, { pattern: "budget", path: budgetFile });
        const budgetText = budgetMatch.content[0].text;
        if (
            !/^1#[A-Z]{3}:budget a/m.test(budgetText) ||
            !/Line 2 cannot fit/.test(budgetText) ||
            !/^3#[A-Z]{3}:budget short$/m.test(budgetText) ||
            budgetMatch.details.truncated !== true
        ) {
            throw new Error("grep lost later matches when a line exceeded the remaining byte budget");
        }
        console.log("--- grep shared byte budget preserves later matches OK ---");

        // Match Pi: context has no arbitrary five-line ceiling, while output remains capped.
        if (byName.grep.parameters.properties.context.maximum !== undefined) {
            throw new Error("grep context still has a maximum");
        }
        const contextual = await run(byName.grep, { pattern: "wide_100 =", path: wideFile, context: 6 });
        const contextLines = [...contextual.content[0].text.matchAll(/^\s*(\d+)#[A-Z]{3}:/gm)].map((m) => Number(m[1]));
        if (contextLines.length !== 13 || contextLines[0] !== 95 || contextLines.at(-1) !== 107) {
            throw new Error("grep context >5 did not show six lines on each side: " + contextLines);
        }
        console.log("--- grep context beyond five lines OK ---");
        const wideContext = await run(byName.grep, { pattern: "wide_100 =", path: wideFile, context: 100000 });
        const wideContextText = wideContext.content[0].text;
        const wideContextLines = wideContextText.split("\n");
        if (
            !wideContext.details.truncated ||
            !wideContext.details.noticeCount ||
            !/Truncated/.test(wideContextText) ||
            Buffer.byteLength(wideContextLines.slice(0, -wideContext.details.noticeCount - 2).join("\n"), "utf8") >
                50 * 1024 ||
            wideContextLines.length - wideContext.details.noticeCount - 2 > 2000
        ) {
            throw new Error("unbounded context did not stop at the output budget");
        }
        console.log("--- grep large context output capped while formatting OK ---");

        // Exhaust the line cap before the byte cap; still report all selected matches and the rg limit.
        for (let i = 0; i < 3; i++) {
            writeFileSync(join(dir, `line-cap-${i}.txt`), `cap-hit\n${"x\n".repeat(2100)}`);
        }
        const lineCapped = await run(byName.grep, {
            pattern: "cap-hit",
            path: dir,
            glob: "line-cap-*.txt",
            limit: 2,
            context: 3000,
        });
        const lineCappedText = lineCapped.content[0].text;
        if (
            !/after 2 selected matches \(stopped at match limit 2\)/.test(lineCappedText) ||
            !lineCapped.details.truncated ||
            !lineCapped.details.noticeCount ||
            lineCappedText.split("\n").length - lineCapped.details.noticeCount - 2 > 2000 ||
            lineCappedText.split("\n").length <= 2000 ||
            !lineCappedText.includes("selected before output cap")
        ) {
            throw new Error("line cap lost the match-limit or selected-match notice");
        }
        console.log("--- grep line cap retains selected count and match limit OK ---");

        // Hidden tracked files appear, but git metadata/ignored files do not.
        mkdirSync(join(dir, ".git"));
        writeFileSync(join(dir, ".git", "HEAD"), "needle metadata\n");
        const hiddenGrep = join(dir, ".hidden-grep.txt");
        const grepPayload = `needle ${"x".repeat(300)}`;
        writeFileSync(hiddenGrep, Array.from({ length: 200 }, (_, i) => `${grepPayload} ${i}`).join("\n") + "\n");
        writeFileSync(join(dir, ".gitignore"), "ignored-grep.txt\n");
        writeFileSync(join(dir, "ignored-grep.txt"), `${grepPayload}\n`);
        const largeGrep = await run(byName.grep, { pattern: "needle", path: dir, limit: 200 });
        const largeGrepText = largeGrep.content[0].text;
        const largeGrepLines = largeGrepText.split("\n");
        if (
            !largeGrepText.includes(".hidden-grep.txt") ||
            largeGrepText.includes("ignored-grep.txt") ||
            largeGrepText.includes(".git/HEAD")
        ) {
            throw new Error("grep hidden/.gitignore behavior failed");
        }
        if (
            !largeGrep.details.noticeCount ||
            Buffer.byteLength(largeGrepLines.slice(0, -largeGrep.details.noticeCount - 2).join("\n"), "utf8") >
                50 * 1024 ||
            largeGrepLines.length - largeGrep.details.noticeCount - 2 > 2000 ||
            !/Truncated/.test(largeGrepText)
        ) {
            throw new Error("grep output did not cap with a continuation notice");
        }
        for (const line of largeGrepLines.filter((line) => /^\s*\d+#/.test(line))) {
            if (!/^\s*\d+#[A-Z]{3}:needle x{300} \d+$/.test(line)) {
                throw new Error("grep emitted a partial or invalid anchor line: " + line.slice(0, 80));
            }
        }
        for (const entry of largeGrep.details.highlights ?? []) {
            if (entry.line >= largeGrepLines.length - largeGrep.details.noticeCount - 2)
                throw new Error("grep highlight points past returned result lines");
            const stripped = largeGrepLines[entry.line].replace(/^\s*\d+#[A-Z]{3}:/, "");
            for (const [start, end] of entry.ranges) {
                if (stripped.slice(start, end) !== "needle")
                    throw new Error("grep highlight range no longer matches output");
            }
        }
        console.log("--- grep hidden + whole-line cap + highlights OK ---");

        let grepError = "";
        try {
            await run(byName.grep, { pattern: "needle", path: join(dir, "does-not-exist") });
        } catch (e) {
            grepError = e.message;
        }
        if (!/ripgrep error/.test(grepError)) {
            throw new Error("grep swallowed a ripgrep failure: " + grepError);
        }
        console.log("--- grep: empty ripgrep failure still errors ---");

        if (process.platform !== "win32" && process.getuid?.() !== 0) {
            const lockedDir = join(dir, "locked");
            mkdirSync(lockedDir);
            writeFileSync(join(dir, "open-hit.ts"), "needle open\n");
            writeFileSync(join(lockedDir, "secret.ts"), "needle secret\n");
            chmodSync(lockedDir, 0o000);
            let partialGrep;
            try {
                partialGrep = await run(byName.grep, { pattern: "needle", path: dir, glob: "*.ts" });
            } finally {
                chmodSync(lockedDir, 0o700);
            }
            const partialText = partialGrep.content[0].text;
            if (!/needle open/.test(partialText) || !/Partial ripgrep results/.test(partialText)) {
                throw new Error("partial ripgrep failure lost its matches: " + partialText.slice(-200));
            }
            if (partialGrep.details.truncated !== true) {
                throw new Error("partial ripgrep failure not flagged as truncated");
            }
            console.log("--- grep: partial ripgrep failure keeps matches + warns ---");
        }
    }
    // 7b. stale recovery: a unique search window still merges onto live content
    const shiftFile = join(dir, "shift.ts");
    writeFileSync(shiftFile, "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n");
    const shiftRead = await run(byName.read, { path: shiftFile });
    const shiftAnchor = shiftRead.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    // external prepend shifts every line; the hunk's window stays unique
    writeFileSync(shiftFile, "const zero = 0;\nconst one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n");
    const shiftEdit = await run(byName.edit, {
        path: shiftFile,
        edits: [{ op: "replace", pos: `2#${shiftAnchor[1]}`, lines: ["const two = 22;"] }],
    });
    const shifted = readFileSync(shiftFile, "utf8");
    if (!/const two = 22;/.test(shifted) || !/const zero = 0;/.test(shifted)) {
        throw new Error("context-matched merge did not apply: " + shifted.replace(/\n/g, "|"));
    }
    if (!/Recovered stale anchors/.test(shiftEdit.content?.[0]?.text ?? "")) {
        throw new Error("merge applied without the recovery warning: " + shiftEdit.content?.[0]?.text);
    }
    console.log("--- stale recovery: unique window merges OK ---");

    // 7c. stale recovery: duplicated search window is refused, nothing written
    const dupFile = join(dir, "dup.ts");
    const dupBlock = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    writeFileSync(dupFile, dupBlock.repeat(2) + "const a = 1;\n");
    const dupRead = await run(byName.read, { path: dupFile });
    const dupAnchor = dupRead.content[0].text.match(/^\s*1#([A-Z]{3}):/m);
    // external prepend (invalidates the anchor's context hash, so recovery runs)
    // plus a repeated block: the hunk window [a,b,c,a] now matches three times
    writeFileSync(dupFile, "const zero = 0;\n" + dupBlock.repeat(3) + "const a = 1;\n");
    let dupOutcome = "";
    try {
        const res = await run(byName.edit, {
            path: dupFile,
            edits: [{ op: "replace", pos: `1#${dupAnchor[1]}`, lines: ["const a = 111;"] }],
        });
        dupOutcome = res.content?.[0]?.text ?? "";
    } catch (e) {
        dupOutcome = e.message;
    }
    if (/111/.test(readFileSync(dupFile, "utf8"))) {
        throw new Error("ambiguous merge wrote the edit anyway: " + readFileSync(dupFile, "utf8").replace(/\n/g, "|"));
    }
    if (!/E_STALE_ANCHOR/.test(dupOutcome) || !/Recovery attempted/.test(dupOutcome)) {
        throw new Error("ambiguous merge not refused with recovery diagnostics: " + dupOutcome);
    }
    console.log("--- stale recovery: ambiguous window refused OK ---");

    // 8. renderer wiring: edit defines NO custom renderers, so pi merges its
    // built-in edit renderers by tool name; read defines a custom (prefix-
    // stripping) result renderer; see 9.
    const fakeTheme = { fg: (name, txt) => `«${name}»${txt}`, bg: (_n, txt) => txt, bold: (txt) => txt };
    const renderToString = (comp) => comp.render(120).join("\n");
    const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
    if (byName.edit.renderCall !== undefined) {
        throw new Error("edit should use pi's built-in call renderer");
    }
    if (byName.edit.renderResult === undefined || byName.read.renderResult === undefined) {
        throw new Error("edit/read should define their result renderers");
    }
    console.log("--- renderer wiring OK (edit call: built-in; results: custom) ---");

    // edit result rendering: diff via pi's renderDiff + the warnings section
    const warnFile = join(dir, "warn.ts");
    writeFileSync(warnFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const wRead = await run(byName.read, { path: warnFile });
    // append after line 1 the exact lines that already follow it: duplicate-insert warning
    const firstAnchor = wRead.content[0].text.match(/^\s*1#([A-Z]{3}):/m);
    const warnRes = await run(byName.edit, {
        path: warnFile,
        edits: [{ op: "append", pos: `1#${firstAnchor[1]}`, lines: ["const b = 2;", "const c = 3;"] }],
    });
    if (!warnRes.details.warnings.length) throw new Error("expected a duplicate-insert warning");
    const wComp = byName.edit.renderResult(warnRes, { isPartial: false }, fakeTheme, {
        state: {},
        lastComponent: undefined,
        isError: false,
        args: { path: warnFile },
    });
    const wText = stripAnsi(renderToString(wComp));
    console.log("--- edit renderResult (diff + warnings) ---");
    console.log(wText.trim());
    if (!/«warning»Potential duplicate insert/.test(wText)) {
        throw new Error("warnings not rendered in warning color: " + JSON.stringify(wText.slice(0, 200)));
    }
    if (/Warnings:/.test(wText)) {
        throw new Error("warnings should render headerless, like pi's own warning notes");
    }
    if (wText.startsWith("\n")) {
        throw new Error("rendered edit result must not add a leading blank line (call Box already pads)");
    }
    if (!/const c = 3;/.test(wText)) throw new Error("diff missing from rendered edit result");
    console.log("--- edit renderResult: diff + warnings OK ---");

    // error results render the model-facing error text
    const errComp = byName.edit.renderResult(
        {
            content: [{ type: "text", text: "[E_STALE_ANCHOR] boom" }],
            details: { diff: "", warnings: [] },
        },
        { isPartial: false },
        fakeTheme,
        { state: {}, lastComponent: undefined, isError: true, args: { path: warnFile } },
    );
    if (!/E_STALE_ANCHOR/.test(stripAnsi(renderToString(errComp))))
        throw new Error("error text missing from rendered edit result");
    console.log("--- edit renderResult: error path OK ---");
    const noopDisplay = stripAnsi(
        renderToString(
            byName.edit.renderResult(endingsNoop, { isPartial: false, expanded: true }, fakeTheme, {
                state: {},
                lastComponent: undefined,
                isError: false,
                args: { path: endingsFile },
            }),
        ),
    );
    if (!noopDisplay.includes("«warning»No changes made")) {
        throw new Error("no-op edit is not styled as a warning: " + JSON.stringify(noopDisplay.slice(0, 120)));
    }

    // collapsed diffs are capped with an expand hint; expanded shows everything
    const longDiff = Array.from({ length: 30 }, (_, i) => `+${i + 1} const v${i} = ${i};`).join("\n");
    const longRes = {
        content: [{ type: "text", text: "anchors" }],
        details: { diff: longDiff, warnings: [] },
    };
    const longCtx = { state: {}, lastComponent: undefined, isError: false, args: { path: warnFile } };
    const collapsedText = stripAnsi(
        renderToString(byName.edit.renderResult(longRes, { isPartial: false, expanded: false }, fakeTheme, longCtx)),
    );
    const expandedText = stripAnsi(
        renderToString(byName.edit.renderResult(longRes, { isPartial: false, expanded: true }, fakeTheme, longCtx)),
    );
    if (!/more diff lines/.test(collapsedText) || !/to expand/.test(collapsedText)) {
        throw new Error("collapsed diff missing expand hint: " + JSON.stringify(collapsedText.slice(-120)));
    }
    if (collapsedText.split("\n").length >= expandedText.split("\n").length) {
        throw new Error("collapsed diff should be shorter than expanded");
    }
    if (!/const v29/.test(expandedText) || /const v29/.test(collapsedText)) {
        throw new Error("expanded diff should show all lines, collapsed should not");
    }
    console.log("--- edit renderResult: collapsed cap + expand hint OK ---");

    // raw ANSI escapes in file content must not survive into the diff renderer
    const escFile = join(dir, "escape.ts");
    writeFileSync(escFile, "const a = 1;\nconst b = 2;\n");
    const escRead = await run(byName.read, { path: escFile });
    const escAnchor = escRead.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    const escRes = await run(byName.edit, {
        path: escFile,
        edits: [{ op: "replace", pos: `2#${escAnchor[1]}`, lines: ["const b = \u001b[2J\u001b[31m2;"] }],
    });
    const escText = renderToString(
        byName.edit.renderResult(escRes, { isPartial: false, expanded: true }, fakeTheme, {
            state: {},
            lastComponent: undefined,
            isError: false,
            args: { path: escFile },
        }),
    );
    if (escText.includes("\u001b[2J") || escText.includes("\u001b[31m")) {
        throw new Error("raw file escapes reached the diff renderer");
    }
    if (!/const b = .*2;/.test(stripAnsi(escText))) {
        throw new Error("edit diff renderer lost the edited line");
    }
    console.log("--- edit renderResult: file escapes sanitized before renderDiff OK ---");
    const warningDisplay = renderToString(
        byName.edit.renderResult(
            {
                content: [{ type: "text", text: "anchors" }],
                details: { diff: "+1 const safe = true;", warnings: ["danger \u001b[31mred\ufff9"] },
            },
            { isPartial: false, expanded: true },
            fakeTheme,
            { state: {}, lastComponent: undefined, isError: false, args: { path: warnFile } },
        ),
    );
    if (warningDisplay.includes("\u001b[31m") || warningDisplay.includes("\ufff9")) {
        throw new Error("unsafe control characters reached the edit warning renderer");
    }

    // duplicate-payload guard still fires through the pipeline
    writeFileSync(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");
    const rr = await run(byName.read, { path: file });
    const anchorM = rr.content[0].text.match(/^\s*2#([A-Z]{3}):/m);
    const editArgs = { path: file, edits: [{ op: "replace", pos: `2#${anchorM[1]}`, lines: ["const y = 24;"] }] };
    await run(byName.edit, editArgs);
    let dupError = null;
    try {
        await run(byName.edit, editArgs);
    } catch (e) {
        dupError = e;
    }
    if (!dupError || !/E_DUPLICATE_EDIT/.test(dupError.message)) throw new Error("expected duplicate guard to fire");
    console.log("--- duplicate guard OK ---");

    // 9. read renderer: content after the LINE#HASH: prefix must be syntax
    // highlighted (the raw prefixed line would highlight as a comment).
    const tsFile = join(dir, "render-check.ts");
    writeFileSync(tsFile, "const value = 1;\n\t// a comment\nexport function hi() { return value; }\n");
    const readRes = await run(byName.read, { path: tsFile });
    const readCtx = {
        state: {},
        lastComponent: undefined,
        argsComplete: true,
        executionStarted: true,
        invalidate: () => {},
        cwd: dir,
        expanded: true,
        isError: false,
        showImages: true,
        args: { path: tsFile },
    };
    const readComp = byName.read.renderResult(readRes, { expanded: true, isPartial: false }, fakeTheme, readCtx);
    const readRendered = renderToString(readComp);
    console.log("--- read renderResult ---");
    console.log(readRendered.slice(0, 300));
    if (!/value/.test(readRendered)) throw new Error("read render lost content");

    // anchors are stripped for display and the code carries highlight colors:
    // a rendered line must contain at least two distinct truecolor codes and
    // no LINE#HASH prefix.
    if (/^\s*\d+#[A-Z]{3}:/m.test(readRendered)) {
        throw new Error("read render still shows anchor prefixes");
    }
    const line1 = readRendered.split("\n").find((l) => l.includes("value = "));
    if (!line1) throw new Error("read render lost line 1");
    const colors = new Set(line1.match(/\u001b\[38;2;[0-9;]+m/g) ?? []);
    if (colors.size < 2) {
        throw new Error("read content not syntax highlighted (one color only): " + JSON.stringify(line1));
    }
    console.log("--- read renderer: prefixes stripped + highlighted code OK ---");
    const limitedRead = await run(byName.read, { path: tsFile, limit: 2 });
    const limitedDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(limitedRead, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: tsFile, limit: 2 },
            }),
        ),
    );
    if (!limitedDisplay.includes("«muted»[Showing lines 1-2 of 3")) {
        throw new Error("read pagination note was syntax highlighted instead of muted");
    }
    const cappedDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(wideRead, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: wideFile },
            }),
        ),
    );
    if (!cappedDisplay.includes("«warning»[Showing lines ")) {
        throw new Error("read truncation note was syntax highlighted instead of warned");
    }
    const emptyFile = join(dir, "empty.ts");
    writeFileSync(emptyFile, "");
    const emptyResult = await run(byName.read, { path: emptyFile });
    const emptyDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(emptyResult, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: emptyFile },
            }),
        ),
    );
    if (!emptyDisplay.includes("«warning»File is empty."))
        throw new Error("empty-file advisory was syntax highlighted");
    const beyondResult = await run(byName.read, { path: tsFile, offset: 99 });
    const beyondDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(beyondResult, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: tsFile, offset: 99 },
            }),
        ),
    );
    if (!beyondDisplay.includes("«warning»Offset 99 is beyond end")) {
        throw new Error("out-of-range advisory was syntax highlighted");
    }
    const badUtf8File = join(dir, "bad-utf8.ts");
    writeFileSync(
        badUtf8File,
        Buffer.concat([Buffer.from("const a = "), Buffer.from([0xff]), Buffer.from(";\nconst b = 2;\n")]),
    );
    const badUtf8Read = await run(byName.read, { path: badUtf8File });
    const badUtf8Display = stripAnsi(
        renderToString(
            byName.read.renderResult(badUtf8Read, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: badUtf8File },
            }),
        ),
    );
    if (!badUtf8Display.includes("«warning»[Non-UTF-8 bytes")) {
        throw new Error("non-UTF-8 warning was syntax highlighted instead of warned");
    }
    const badUtf8Page = await run(byName.read, { path: badUtf8File, limit: 1 });
    const badUtf8PageDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(badUtf8Page, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: badUtf8File, limit: 1 },
            }),
        ),
    );
    if (
        !badUtf8PageDisplay.includes("«muted»[Showing lines 1-1 of 2") ||
        !badUtf8PageDisplay.includes("«warning»[Non-UTF-8 bytes")
    ) {
        throw new Error("paginated non-UTF-8 warning was not shown separately in warning color");
    }
    const oversizedDisplay = stripAnsi(
        renderToString(
            byName.read.renderResult(big, { expanded: true, isPartial: false }, fakeTheme, {
                ...readCtx,
                args: { path: bigFile },
            }),
        ),
    );
    if (!oversizedDisplay.includes("«warning»[Line 1 cannot fit")) {
        throw new Error("oversized read advisory was not styled as warning");
    }
    if (!readRes.content[0].text.includes("\t// a comment") || readRendered.includes("\t")) {
        throw new Error("read renderer did not expand tabs for display only");
    }

    // raw mode has no prefixes; content must still be highlighted
    const rawRes = await run(byName.read, { path: tsFile, raw: true });
    const rawComp = byName.read.renderResult(rawRes, { expanded: true, isPartial: false }, fakeTheme, {
        ...readCtx,
        args: { path: tsFile, raw: true },
    });
    const rawRendered = renderToString(rawComp);
    const rawLine = rawRendered.split("\n").find((l) => l.includes("value = "));
    const rawColors = new Set((rawLine ?? "").match(/\u001b\[38;2;[0-9;]+m/g) ?? []);
    if (rawColors.size < 2) {
        throw new Error("raw read not highlighted: " + JSON.stringify(rawLine));
    }
    console.log("--- read renderer: raw mode highlighted OK ---");

    // 10. grep renderer: prefixes stripped, 15-line collapsed cap with expand hint
    const grepRes = await run(byName.grep, { pattern: "const ", path: dir, glob: "*.ts", limit: 5 });
    const gCtx = {
        state: {},
        lastComponent: undefined,
        argsComplete: true,
        executionStarted: true,
        invalidate: () => {},
        cwd: dir,
        expanded: false,
        isError: false,
    };
    const gComp = byName.grep.renderResult(grepRes, { expanded: false, isPartial: false }, fakeTheme, gCtx);
    const gText = stripAnsi(renderToString(gComp));
    if (/^\s*\d+#[A-Z]{3}:/m.test(gText)) throw new Error("grep render still shows anchor prefixes");
    if (!/const /.test(gText)) throw new Error("grep render lost content");
    const cappedResult = await run(byName.grep, { pattern: "needle", path: dir, limit: 200 });
    const cappedGrepDisplay = stripAnsi(
        renderToString(byName.grep.renderResult(cappedResult, { expanded: false, isPartial: false }, fakeTheme, gCtx)),
    );
    if (!cappedGrepDisplay.includes("«warning»[Truncated") || !cappedGrepDisplay.includes("«searchMatchText»needle")) {
        throw new Error("grep truncation notice was hidden or not warning-colored");
    }
    const omittedResult = await run(byName.grep, { pattern: "oversized", path: join(dir, "long-match.txt") });
    const omittedDisplay = stripAnsi(
        renderToString(byName.grep.renderResult(omittedResult, { expanded: true, isPartial: false }, fakeTheme, gCtx)),
    );
    if (
        !omittedDisplay.includes("«warning»[Line 1 cannot fit") ||
        !omittedDisplay.includes("«warning»[1 line(s) shown as placeholders")
    ) {
        throw new Error("grep oversized-line notices were not warning-colored");
    }
    const gExpanded = stripAnsi(
        renderToString(
            byName.grep.renderResult(grepRes, { expanded: true, isPartial: false }, fakeTheme, {
                ...gCtx,
                expanded: true,
            }),
        ),
    );
    if (!/const /.test(gExpanded)) throw new Error("expanded grep render lost content");
    console.log("--- grep renderer: prefixes stripped OK ---");

    // 11. grep highlighting: rg byte offsets to JS char offsets (multi-byte safe)
    const hlFile = join(dir, "hl.ts");
    writeFileSync(
        hlFile,
        'const emoji = "\u{1F3AF}\u{1F3AF}"; const \ufff9target = 1;\nconst plain = 2;\nconst target2 = 3;\n',
    );
    const hlRes = await run(byName.grep, { pattern: "target", path: hlFile });
    const outLines = hlRes.content[0].text.split("\n");
    const highlights = hlRes.details.highlights ?? [];
    if (highlights.length !== 2) throw new Error("expected 2 highlighted lines, got " + JSON.stringify(highlights));
    for (const entry of highlights) {
        const stripped = outLines[entry.line].replace(/^\s*\d+#[^:]{1,4}:/, "");
        for (const [start, end] of entry.ranges) {
            if (stripped.slice(start, end) !== "target") {
                throw new Error(
                    `highlight range ${start}-${end} did not slice out "target": ${JSON.stringify(stripped.slice(start, end))}`,
                );
            }
        }
    }
    const hlTheme = { fg: (n, t) => `\u00ab${n}\u00bb${t}`, bg: (n, t) => `\u00ab${n}\u00bb${t}`, bold: (t) => t };
    const hlText = stripAnsi(
        renderToString(
            byName.grep.renderResult(hlRes, { expanded: true, isPartial: false }, hlTheme, { ...gCtx, expanded: true }),
        ),
    );
    if (!/\u00absearchMatchBg\u00bb\u00absearchMatchText\u00bbtarget/.test(hlText)) {
        throw new Error("match not highlighted: " + JSON.stringify(hlText.slice(0, 200)));
    }
    if (/\u00absearchMatchBg\u00bb[^\u00ab]*plain/.test(hlText)) throw new Error("context line was highlighted");
    if (/^\s*\d+#[^:]{1,4}:/m.test(hlText)) throw new Error("highlighted render still shows anchor prefixes");
    console.log("--- grep renderer: match highlighting OK ---");

    // 12. file-kind: text / binary (null bytes) / image (pi's detector) / directory
    const fk = jiti("./src/file-kind.ts");
    const textKind = await fk.loadFileKindAndText(join(dir, "sample.ts"));
    if (textKind.kind !== "text" || !textKind.text.includes("const")) throw new Error("text classification failed");
    const binFile = join(dir, "bin.dat");
    writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
    if ((await fk.loadFileKindAndText(binFile)).kind !== "binary") throw new Error("binary classification failed");
    const pngFile = join(dir, "img.png");
    writeFileSync(
        pngFile,
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
        ),
    );
    if ((await fk.loadFileKindAndText(pngFile)).kind !== "image") throw new Error("image classification failed");
    if ((await fk.loadFileKindAndText(dir)).kind !== "directory") throw new Error("directory classification failed");
    console.log("--- file-kind: text / binary / image / directory OK ---");
    const imageResult = await run(byName.read, { path: pngFile });
    const hiddenImage = byName.read.renderResult(imageResult, { expanded: true, isPartial: false }, fakeTheme, {
        ...readCtx,
        args: { path: pngFile },
        showImages: false,
        lastComponent: undefined,
    });
    if (!stripAnsi(renderToString(hiddenImage)).includes("[Image:")) {
        throw new Error("read renderer omitted Pi's image fallback placeholder");
    }
    console.log("--- hidden image renderer fallback OK ---");

    // 12b. expected-version mismatch cleans the temp file and prevents overwrite.
    const fsWrite = jiti("./src/fs-write.ts");
    const atomicFile = join(dir, "atomic.txt");
    writeFileSync(atomicFile, "before\n");
    let atomicError = "";
    try {
        await fsWrite.writeFileAtomically(atomicFile, "after\n", {
            alreadyResolved: true,
            expectedContent: "stale\n",
        });
    } catch (error) {
        atomicError = error.message;
    }
    if (!/E_FILE_CHANGED/.test(atomicError) || readFileSync(atomicFile, "utf8") !== "before\n") {
        throw new Error("atomic expected-version guard failed");
    }
    if (readdirSync(dir).some((name) => name.startsWith(".tmp-"))) {
        throw new Error("atomic write failure left a temp file");
    }
    console.log("--- atomic write race guard + temp cleanup OK ---");

    rmSync(dir, { recursive: true, force: true });
    console.log("\npi-hashline check passed");
})().catch((e) => {
    console.error("pi-hashline check failed:", e);
    process.exit(1);
});
