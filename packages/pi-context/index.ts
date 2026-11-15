import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompaction } from "./src/compaction.ts";
import { registerPrune } from "./src/prune.ts";
import { registerRtk } from "./src/rtk.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
    // RTK is optional: without it in PATH, commands run unmodified.
    await registerRtk(pi);
    registerPrune(pi);
    registerCompaction(pi);
}
