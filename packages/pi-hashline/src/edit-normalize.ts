/** prepareArguments runs before Pi validation: accept file_path and JSON-string edits,
 * reject null "lines" payloads, but leave text-replace payloads for the anchor-guidance error. */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse JSON-string edits, then reject null "lines" payloads: Value.Convert
 * turns null into ["null"], which passes validation and would write the
 * literal text "null" into the file. Null pos/end need no handling: Pi's
 * normalizeOptionalNulls deletes them now that the item schema is flat.
 */
function coerceEditsArray(edits: unknown): unknown {
    let parsed: unknown = edits;
    if (typeof parsed === "string") {
        try {
            const json: unknown = JSON.parse(parsed);
            if (Array.isArray(json)) {
                parsed = json;
            }
        } catch {
            // Leave malformed input intact for validation's more precise error.
        }
    }
    if (Array.isArray(parsed)) {
        for (const [index, edit] of parsed.entries()) {
            if (isRecord(edit) && edit.lines === null) {
                throw new Error(
                    `Edit ${index}: "lines" is null. "lines" is required content; provide an array of lines.`,
                );
            }
        }
    }
    return parsed;
}

/** Leave malformed input intact for validation's more precise error. */
export function normalizeEditRequest(input: unknown): unknown {
    if (!isRecord(input)) {
        return input;
    }

    const record: Record<string, unknown> = { ...input };

    if (typeof record.path !== "string" && typeof record.file_path === "string") {
        record.path = record.file_path;
        delete record.file_path;
    }

    if (Object.hasOwn(record, "edits")) {
        record.edits = coerceEditsArray(record.edits);
    }

    return record;
}
