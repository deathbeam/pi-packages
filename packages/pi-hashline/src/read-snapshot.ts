/** Recent snapshots let stale anchors recover across reads; the size cap is soft because JS counts UTF-16 code units. */

const MAX_PATHS = 8;
const MAX_VERSIONS_PER_PATH = 4;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// Paths and their versions are both newest-first.
const pathOrder: string[] = [];
const pathMap = new Map<string, string[]>();
// Paths first seen through grep; evicted before read snapshots.
const grepPaths = new Set<string>();

function totalSize(): number {
    let n = 0;
    for (const versions of pathMap.values()) {
        for (const version of versions) {
            n += version.length;
        }
    }
    return n;
}

/** Grep-only paths go first, so a broad search cannot squeeze out read snapshots. */
function evictionTarget(): string | undefined {
    return pathOrder.findLast((path) => grepPaths.has(path)) ?? pathOrder.at(-1);
}

function evictOldestVersion(): void {
    const target = evictionTarget();
    if (target === undefined) return;
    const versions = pathMap.get(target);
    if (!versions?.length) return;
    versions.pop();
    if (versions.length === 0) {
        pathMap.delete(target);
        grepPaths.delete(target);
        pathOrder.splice(pathOrder.indexOf(target), 1);
    }
}

function moveToFront(canonicalPath: string): void {
    const idx = pathOrder.indexOf(canonicalPath);
    if (idx > 0) {
        pathOrder.splice(idx, 1);
        pathOrder.unshift(canonicalPath);
    }
}

export function rememberReadSnapshot(canonicalPath: string, content: string, fromGrep = false): void {
    // Only a path first seen through grep is evictable.
    if (!fromGrep) {
        grepPaths.delete(canonicalPath);
    } else if (!pathMap.has(canonicalPath)) {
        grepPaths.add(canonicalPath);
    }

    const existing = pathMap.get(canonicalPath);

    if (existing && existing.length > 0 && existing[0] === content) {
        moveToFront(canonicalPath);
        return;
    }

    if (existing) {
        existing.unshift(content);
        while (existing.length > MAX_VERSIONS_PER_PATH) {
            existing.pop();
        }
        moveToFront(canonicalPath);
    } else {
        if (pathOrder.length >= MAX_PATHS) {
            const lruPath = evictionTarget()!;
            pathMap.delete(lruPath);
            grepPaths.delete(lruPath);
            pathOrder.splice(pathOrder.indexOf(lruPath), 1);
        }
        pathMap.set(canonicalPath, [content]);
        pathOrder.unshift(canonicalPath);
    }

    while (totalSize() > MAX_TOTAL_BYTES) {
        evictOldestVersion();
        if (pathMap.size === 0) break;
    }
}

// Duplicate-edit detection compares against the newest snapshot only.
export function getReadSnapshot(canonicalPath: string): string | null {
    const versions = pathMap.get(canonicalPath);
    return versions && versions.length > 0 ? versions[0]! : null;
}

export function getReadSnapshotVersions(canonicalPath: string): string[] {
    const versions = pathMap.get(canonicalPath);
    return versions ? [...versions] : [];
}
