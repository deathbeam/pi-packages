import { defineConfig } from "vitest/config";

// Scoped include keeps vitest out of .pi/worktrees clones.
export default defineConfig({
    test: { include: ["packages/*/test/**/*.test.ts"] },
});
