/* Shared helpers for the pi-hashline tests: temp files, tool calls and renderer setup. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const fakeTheme: any = {
    fg: (name: string, text: string) => `«${name}»${text}`,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
};

function keyHint(_keybinding: string, description: string): string {
    return `«key»${description}`;
}

export function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: { render: (width: number) => string[] }): string {
    return component.render(120).join("\n");
}

/** The `LINE#HASH` anchor that read printed for `line`, e.g. `2#ABC`. */
export function anchorAt(readOutput: string, line: number): string {
    const hash = readOutput.match(new RegExp(`^\\s*${line}#([A-Z]{3}):`, "m"))?.[1];
    assert.ok(hash, `no anchor for line ${line} in:\n${readOutput}`);
    return `${line}#${hash}`;
}

/** Many short code lines, enough to overflow the read and grep output caps. */
export function wideLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `const wide_${i} = "${"x".repeat(40)}";`).join("\n") + "\n";
}

/** `count` long but anchorable matches, enough to overflow the grep output caps. */
export function needleLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `needle ${"x".repeat(300)} ${i}`).join("\n") + "\n";
}

/** A match on a line too long to anchor (60KB) followed by a short match. */
export function oversizedMatch(): string {
    return `oversized ${"x".repeat(60 * 1024)}\noversized short\n`;
}

export function createHarness() {
    // renderDiff reads pi's global theme singleton; initialize it headless.
    initTheme();

    const registered: any[] = [];
    extension({ registerTool: (tool: any) => registered.push(tool) } as any);
    const byName: Record<string, any> = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
    const dir = mkdtempSync(join(tmpdir(), "hashline-test-"));
    const ctx = { cwd: dir };
    const noop = () => {};

    const write = (name: string, content: string | Buffer): string => {
        const path = join(dir, name);
        writeFileSync(path, content);
        return path;
    };
    const read = (params: any, signal?: AbortSignal) => byName.read.execute("id", params, signal, noop, ctx);
    const edit = (params: any, signal?: AbortSignal) => byName.edit.execute("id", params, signal, noop, ctx);
    const grep = (params: any, signal?: AbortSignal) => byName.grep.execute("id", params, signal, noop, ctx);
    // The full model path: prepareArguments, pi validation, then execute.
    const agentLoopRun = (tool: any, params: any) =>
        tool.execute(
            "id",
            validateToolArguments(
                { name: tool.name, parameters: tool.parameters } as any,
                { name: tool.name, arguments: tool.prepareArguments(params) } as any,
            ),
            undefined,
            noop,
            ctx,
        );
    const readText = async (path: string, params: Record<string, unknown> = {}) =>
        (await read({ path, ...params })).content[0].text;

    const renderRead = (result: any, args: any, { strip = true, ...overrides }: any = {}) => {
        const text = render(
            byName.read.renderResult(result, { expanded: true, isPartial: false }, fakeTheme, {
                state: {},
                lastComponent: undefined,
                argsComplete: true,
                executionStarted: true,
                invalidate: () => {},
                cwd: dir,
                expanded: true,
                isError: false,
                keyHint,
                showImages: true,
                args,
                ...overrides,
            }),
        );
        return strip ? stripAnsi(text) : text;
    };
    const renderEdit = (result: any, args: any, { expanded, isError, strip = true }: any = {}) => {
        const text = render(
            byName.edit.renderResult(result, { isPartial: false, expanded }, fakeTheme, {
                state: {},
                lastComponent: undefined,
                isError: isError ?? false,
                keyHint,
                args,
            }),
        );
        return strip ? stripAnsi(text) : text;
    };
    const renderGrep = (result: any, { expanded = false, args, theme, strip = true }: any = {}) => {
        const text = render(
            byName.grep.renderResult(result, { expanded, isPartial: false }, theme ?? fakeTheme, {
                state: {},
                lastComponent: undefined,
                argsComplete: true,
                executionStarted: true,
                invalidate: () => {},
                cwd: dir,
                expanded,
                isError: false,
                keyHint,
                args,
            }),
        );
        return strip ? stripAnsi(text) : text;
    };

    return {
        dir,
        registered,
        byName,
        ctx,
        write,
        read,
        edit,
        grep,
        agentLoopRun,
        readText,
        renderRead,
        renderEdit,
        renderGrep,
        close: () => rmSync(dir, { recursive: true, force: true }),
    };
}

export type Harness = ReturnType<typeof createHarness>;
