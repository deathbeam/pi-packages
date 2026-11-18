import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, it } from "vitest";
import { cleanupTempDirs, tempDir, writeSettings } from "./helpers.ts";
import { readImagesSettings } from "../index.ts";
import { splitModel } from "../src/generate.ts";

const project = tempDir("pi-images-project-");
const home = process.env.HOME!;

/** The global half of the merge lives in `<HOME>/.pi/agent/settings.json`. */
function writeGlobalSettings(images: unknown): void {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ images }));
}

afterAll(cleanupTempDirs);

describe("splitModel", () => {
    it("splits at the first slash so ids may contain slashes", () => {
        assert.deepEqual(splitModel("inferhub/cb/gemini-3.0-pro-image"), {
            provider: "inferhub",
            id: "cb/gemini-3.0-pro-image",
        });
        assert.deepEqual(splitModel("anthropic/claude-haiku-4-5"), {
            provider: "anthropic",
            id: "claude-haiku-4-5",
        });
    });

    it("rejects values without a provider or an id", () => {
        for (const value of ["no-provider", "/leading", "trailing/"]) {
            assert.throws(() => splitModel(value), /must be/, value);
        }
    });
});

describe("readImagesSettings", () => {
    afterEach(() => writeGlobalSettings({}));

    it("reads the project settings file", () => {
        writeSettings(project, { vision: "anthropic/v", generate: "inferhub/g", outputDir: "out" });
        assert.deepEqual(readImagesSettings(project), {
            vision: "anthropic/v",
            generate: "inferhub/g",
            outputDir: "out",
        });
    });

    it("lets project settings override global ones", () => {
        writeGlobalSettings({ vision: "a/b", outputDir: "g" });
        writeSettings(project, { vision: "c/d" });
        assert.deepEqual(readImagesSettings(project), { vision: "c/d", outputDir: "g" });
    });

    it("ignores non-string and empty settings", () => {
        writeSettings(project, { vision: 1, generate: null, outputDir: "" });
        assert.deepEqual(readImagesSettings(project), {});
        writeSettings(project, {});
        assert.deepEqual(readImagesSettings(project), {});
    });

    it("returns nothing when the project has no settings file", () => {
        assert.deepEqual(readImagesSettings(tempDir("pi-images-empty-")), {});
    });

    it("returns nothing for an unparsable settings file", () => {
        mkdirSync(join(project, ".pi"), { recursive: true });
        writeFileSync(join(project, ".pi", "settings.json"), "{not json");
        assert.deepEqual(readImagesSettings(project), {});
    });
});
