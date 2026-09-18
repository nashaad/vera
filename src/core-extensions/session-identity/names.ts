import { randomBytes } from "node:crypto";

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
    readonly purpose?: string;
}

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX4_PATTERN = /^[0-9a-f]{4}$/;
const PURPOSE_PATTERN = /^[^:\s/]+$/;

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

export function agentNameKey(value: string): string | null {
    const parsed = parseAgentName(value);
    return parsed === null ? null : `${parsed.slug}:${parsed.hex4}`;
}

export function agentNameForFilename(name: string): string {
    return name.replaceAll(":", "-");
}

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
