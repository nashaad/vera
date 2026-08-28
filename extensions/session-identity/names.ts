import { randomBytes } from "node:crypto";

/**
 * Session identity names: `slug:hex4` with an optional `:purpose` tail, e.g.
 * `frosty-frost:9f3a:UAT-tester`. Matching and addressing use `slug:hex4`
 * only; purpose is display decoration. Colons are the separator and are
 * banned inside fields; they mangle to `-` only at filename boundaries.
 *
 * hex4 only disambiguates the spoken name, so it stays small. Real uniqueness
 * comes from the session UUID underneath and the node id on the transport.
 */

const ADJECTIVES = [
    "amber", "bold", "brisk", "calm", "civil", "clear", "crisp", "deft",
    "dusky", "eager", "fleet", "frosty", "gentle", "glad", "grand", "hardy",
    "keen", "lively", "lucid", "mellow", "misty", "nimble", "plain", "quick",
    "quiet", "rapid", "rustic", "sable", "solar", "steady", "stout", "swift",
    "tidy", "vivid", "wild", "witty",
] as const;

const NOUNS = [
    "aspen", "badger", "birch", "brook", "cedar", "cliff", "comet", "crane",
    "delta", "ember", "falcon", "fern", "frost", "gale", "glade", "harbor",
    "heron", "inlet", "jetty", "knoll", "lark", "maple", "marsh", "otter",
    "pine", "quartz", "reef", "ridge", "river", "slate", "spruce", "stone",
    "summit", "thicket", "wren",
] as const;

export interface ParsedAgentName {
    readonly slug: string;
    readonly hex4: string;
    /** Absent when the name carries no display decoration. */
    readonly purpose?: string;
}

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX4_PATTERN = /^[0-9a-f]{4}$/;
const PURPOSE_PATTERN = /^[^:\s/]+$/;

/**
 * Splits a name into its fields, or `null` when the text is not a name. A
 * fourth colon-separated field is a malformed name, not extra decoration,
 * because purpose is one field and colons are banned inside fields.
 */
export function parseAgentName(value: string): ParsedAgentName | null {
    const parts = value.split(":");
    if (parts.length < 2 || parts.length > 3) {
        return null;
    }
    const [slug, hex4, purpose] = parts;
    if (!SLUG_PATTERN.test(slug!) || !HEX4_PATTERN.test(hex4!)) {
        return null;
    }
    if (purpose !== undefined && !PURPOSE_PATTERN.test(purpose)) {
        return null;
    }
    return {
        slug: slug!,
        hex4: hex4!,
        ...(purpose === undefined ? {} : { purpose }),
    };
}

/**
 * The `slug:hex4` half a name matches and addresses by, or `null` when the
 * text is not a name at all. Purpose never participates in matching.
 */
export function agentNameKey(value: string): string | null {
    const parsed = parseAgentName(value);
    return parsed === null ? null : `${parsed.slug}:${parsed.hex4}`;
}

/** Colons mangle to hyphens at filename boundaries and nowhere else. */
export function agentNameForFilename(name: string): string {
    return name.replaceAll(":", "-");
}

/**
 * Mints a fresh `slug:hex4` name whose key is not currently taken. The
 * caller's predicate closes over the live sessions, which is what makes a
 * key collision among them impossible by construction rather than unlikely.
 */
export function mintAgentName(
    isTaken: (key: string) => boolean,
    random: (bytes: number) => Buffer = randomBytes,
): string {
    for (;;) {
        const seed = random(4);
        const adjective = ADJECTIVES[seed[0]! % ADJECTIVES.length]!;
        const noun = NOUNS[seed[1]! % NOUNS.length]!;
        const hex4 = ((seed[2]! << 8) | seed[3]!)
            .toString(16)
            .padStart(4, "0");
        const name = `${adjective}-${noun}:${hex4}`;
        if (!isTaken(name)) {
            return name;
        }
    }
}
