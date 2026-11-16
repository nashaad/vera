import type { SandboxViolation, SandboxViolationKind } from "./types.ts";

const MAX_LISTED_LINES = 5;
const RAW_LINE_LIMIT = 300;

// srt reports a denial as `deny(<n>) <operation> <target>`, sometimes behind
// a `Sandbox:` prefix and a process label.
const DENIAL = /deny(?:\(\d+\))?\s+([a-zA-Z0-9_-]+)\s+(.+)$/;

export function classifyViolation(raw: string): SandboxViolation {
    const line = raw.trim();
    const match = DENIAL.exec(line);
    if (match === null) {
        return { kind: "other", target: "", line: clip(line) };
    }
    const operation = match[1]!;
    let target = match[2]!.trim();
    const kind = kindOf(operation);
    if (kind === "connect") {
        const parenthetical = target.indexOf(" (");
        if (parenthetical !== -1) target = target.slice(0, parenthetical);
    }
    return { kind, target, line: clip(line) };
}

function kindOf(operation: string): SandboxViolationKind {
    if (operation.startsWith("file-read")) return "read";
    if (
        operation.startsWith("file-write")
        || operation === "file-create"
        || operation === "unlink"
        || operation === "rename"
        || operation === "truncate"
    ) {
        return "write";
    }
    if (operation.startsWith("network-outbound") || operation === "network-connect") {
        return "connect";
    }
    return "other";
}

/** The block appended to a command's output; empty when nothing was blocked. */
export function formatViolationBlock(
    violations: readonly SandboxViolation[],
): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const violation of violations) {
        if (violation.kind === "other") continue;
        const line = `${violation.kind} ${violation.target}`.trim();
        if (seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
    }
    if (lines.length === 0) return "";
    const listed = lines.slice(0, MAX_LISTED_LINES);
    const rest = lines.length - listed.length;
    return [
        "Blocked by sandbox:",
        ...listed.map((line) => `  ${line}`),
        ...(rest > 0 ? [`  and ${rest} more`] : []),
    ].join("\n");
}

function clip(line: string): string {
    return line.length > RAW_LINE_LIMIT
        ? `${line.slice(0, RAW_LINE_LIMIT - 3)}...`
        : line;
}
