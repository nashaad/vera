// srt stamps every denial with a per-process suffix and a tag holding the
// attribution key. Both are readable from a wrapped command, and the tag is
// readable from the kernel log line, so recovery needs no private import.

const SESSION_SUFFIX = /_([a-z0-9]{6,16})_SBX/;
const ATTRIBUTION_TAG = /CMD64_([A-Za-z0-9+/=]+)_END_/;

/** The suffix srt adds to this process's log predicate. */
export function sandboxSessionSuffix(
    argv: readonly string[],
): string | undefined {
    return SESSION_SUFFIX.exec(argv.join("\n"))?.[1];
}

/** The command id a denial line was stamped with. */
export function decodeAttribution(text: string): string | undefined {
    const encoded = ATTRIBUTION_TAG.exec(text)?.[1];
    if (encoded === undefined) return undefined;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    return decoded.length === 0 ? undefined : decoded;
}
