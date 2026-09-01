import type { JsonValue } from "./contributions.ts";

const SECRET_PREFIXES = [
    "github_pat_",
    "sk-ant-",
    "gho_",
    "ghp_",
    "xoxb-",
    "sk-",
    "AKIA",
] as const;

const SECRET_RUN = new RegExp(
    `(${SECRET_PREFIXES.join("|")})\\S+`,
    "g",
);
const MAX_REPORTED_CHARACTERS = 300;

export function redactSecretShapedText(text: string): string {
    const flattened = text.replace(/\s+/g, " ").trim();
    const redacted = flattened.replace(SECRET_RUN, "$1...");
    return redacted.length > MAX_REPORTED_CHARACTERS
        ? `${redacted.slice(0, MAX_REPORTED_CHARACTERS)}...`
        : redacted;
}

export interface LiteralSecretFinding {
    readonly extensionId: string;
    readonly configPath: string;
    readonly prefix: string;
}

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
