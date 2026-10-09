/**
 * Hashline engine: hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

export type { HashlineToolEdit } from "./hashline/parse";
export { HASH_LENGTH, computeLineHash } from "./hashline/hash";
export { resolveEditAnchors } from "./hashline/parse";
export { applyHashlineEdits, type NoopEdit } from "./hashline/apply";
export {
    computeAffectedLineRange,
    computeChangedLineRange,
    formatHashlineRegion,
    sanitizeOutput,
    splitVisibleLines,
    stripHashlinePrefixes,
} from "./hashline/format";
