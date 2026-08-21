import type { JsonValue } from "./contributions.ts";

/**
 * Value prefixes that identify a credential by shape. Key names are never
 * consulted: a value is a secret because of what it looks like, not because
 * of what it was called.
 */
const SECRET_PREFIXES = [
    "github_pat_",
    "sk-ant-",
    "gho_",
    "ghp_",
    "xoxb-",
    "sk-",
    "AKIA",
] as const;

/** Matches a credential-shaped run anywhere inside a longer string. */
const SECRET_RUN = new RegExp(
    `(${SECRET_PREFIXES.join("|")})\\S+`,
    "g",
);
const MAX_REPORTED_CHARACTERS = 300;

/**
 * Makes text safe to put in front of the model. An extension is free to put
 * its own resolved config in an error message, and a config key is whatever
 * the file said, so both arrive here as text that can carry a credential or
 * its own line breaks.
 */
export function redactSecretShapedText(text: string): string {
    const flattened = text.replace(/\s+/g, " ").trim();
    const redacted = flattened.replace(SECRET_RUN, "$1...");
    return redacted.length > MAX_REPORTED_CHARACTERS
        ? `${redacted.slice(0, MAX_REPORTED_CHARACTERS)}...`
        : redacted;
}

export interface LiteralSecretFinding {
    readonly extensionId: string;
    /** Dotted path inside the extension's config, `""` for the root value. */
    readonly configPath: string;
    /** The prefix that matched, so a report never carries the value. */
    readonly prefix: string;
}

/**
 * Reports config values that hold a credential literally. Run before env
 * references resolve: a resolved value is expected to look like a secret, so
 * only what a config file itself carries is worth reporting.
 */
export function findLiteralSecrets(
    value: JsonValue,
    extensionId: string,
): readonly LiteralSecretFinding[] {
    const findings: LiteralSecretFinding[] = [];
    walk(value, extensionId, "", findings);
    return findings;
}

function walk(
    value: JsonValue,
    extensionId: string,
    path: string,
    findings: LiteralSecretFinding[],
): void {
    if (typeof value === "string") {
        const prefix = SECRET_PREFIXES.find((candidate) =>
            value.startsWith(candidate)
        );
        if (prefix !== undefined) {
            findings.push({ extensionId, configPath: path, prefix });
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            walk(entry, extensionId, `${path}[${index}]`, findings)
        );
        return;
    }
    if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
            const segment = redactSecretShapedText(key);
            walk(
                entry,
                extensionId,
                path === "" ? segment : `${path}.${segment}`,
                findings,
            );
        }
    }
}
