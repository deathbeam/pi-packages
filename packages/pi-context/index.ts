import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompaction } from "./src/compaction.ts";
import { registerGain } from "./src/gain.ts";
import { registerPrune } from "./src/prune.ts";
import { registerRtk } from "./src/rtk.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
    const gain = registerGain(pi);
    // Registered before the RTK probe, so a hung rtk binary cannot block them.
    registerPrune(pi, gain);
    registerCompaction(pi);
    // RTK is optional: without it in PATH, commands run unmodified.
    await registerRtk(pi, gain);
}
