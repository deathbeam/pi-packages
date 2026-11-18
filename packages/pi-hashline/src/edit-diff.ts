export function detectLineEnding(content: string): "\r\n" | "\n" {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1 || crlfIdx === -1) return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// Returns true when normalizeToLF + restoreLineEndings will not round-trip the
// file's endings: mixed styles (CRLF plus bare LF, or lone CR mixed with
// anything), or a pure classic-Mac CR file (detectLineEnding has no CR branch,
// so an edit rewrites it as LF). A file uniform in LF or CRLF returns false.
export function hasMixedLineEndings(content: string): boolean {
    const hasCrlf = /\r\n/.test(content);
    // Bare LF: a \n not immediately preceded by \r
    const hasBareLf = /(?<!\r)\n/.test(content);
    // Lone CR: a \r not followed by \n
    const hasLoneCr = /\r(?!\n)/.test(content);

    const styleCount = [hasCrlf, hasBareLf, hasLoneCr].filter(Boolean).length;
    return styleCount > 1 || hasLoneCr;
}

export function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
