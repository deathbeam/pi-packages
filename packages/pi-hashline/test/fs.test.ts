import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { loadFileKindAndText } from "../src/file-kind.ts";
import { writeFileAtomically } from "../src/fs-write.ts";
import { createHarness, type Harness } from "./helpers.ts";

const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

let h: Harness;

beforeAll(() => {
    h = createHarness();
});

afterAll(() => h.close());

describe("file kind", () => {
    it("loads text with its decoded content", async () => {
        assert.deepEqual(await loadFileKindAndText(h.write("kind.txt", "const x = 1;\n")), {
            kind: "text",
            text: "const x = 1;\n",
        });
    });

    it("classifies null bytes as binary, pngs as image and a directory as directory", async () => {
        const binary = h.write("kind.dat", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
        assert.equal((await loadFileKindAndText(binary)).kind, "binary");
        assert.equal((await loadFileKindAndText(h.write("kind.png", pngBytes))).kind, "image");
        assert.equal((await loadFileKindAndText(h.dir)).kind, "directory");
    });

    it("falls back to pi's image placeholder when images are hidden", async () => {
        const file = h.write("hidden.png", pngBytes);
        const result = await h.read({ path: file });
        assert.match(h.renderRead(result, { path: file }, { showImages: false }), /\[Image:/);
    });
});

describe("atomic write", () => {
    it("refuses an expected-version mismatch and cleans its temp file", async () => {
        const file = h.write("atomic.txt", "before\n");
        await assert.rejects(
            writeFileAtomically(file, "after\n", { alreadyResolved: true, expectedContent: "stale\n" }),
            /E_FILE_CHANGED/,
        );
        assert.equal(readFileSync(file, "utf8"), "before\n");
        assert.deepEqual(
            readdirSync(h.dir).filter((name) => name.startsWith(".tmp-")),
            [],
        );
    });
});
