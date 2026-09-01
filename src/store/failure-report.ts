import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitizeDiagnosticText } from "../model/diagnostic-text.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";
import {
    summariseModelFailures,
    type ModelFailureRecord,
    type ModelFailureSummary,
} from "./model-failures.ts";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const USER_PATH = /\/(Users|home)\/[^/\s"'`]+/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`?]+)\?[^\s"'`]*/gi;

export function sanitizeReportText(
    value: string,
    home: string = homedir(),
): string {
    const withoutHome = home.length > 0 ? value.replaceAll(home, "~") : value;
    return sanitizeDiagnosticText(withoutHome)
        .replace(URL_USERINFO, "$1[redacted-user]@")
        .replace(URL_QUERY, "$1?[redacted-query]")
        .replace(EMAIL, "[redacted-email]")
        .replace(USER_PATH, "/$1/[redacted-user]");
}

export function defaultFailureReportDirectory(
    root: string = veraRuntimeDirectory(),
): string {
    return join(root, "reports");
}

export interface FailureReportOptions {
    readonly records: readonly ModelFailureRecord[];
    readonly at: Date;
    readonly home?: string;
    readonly summary?: string;
}

export function failureReportMarkdown(options: FailureReportOptions): string {
    const scrub = (value: string): string =>
        sanitizeReportText(value, options.home);
    const summary = summariseModelFailures(options.records);
    const lines = [
        "# Vera model failure report",
        "",
        `Generated ${options.at.toISOString()}.`,
        `${summary.total} failures across ${summary.signatures.length} signatures.`,
        "",
    ];
    if (options.summary !== undefined && options.summary.trim().length > 0) {
        lines.push("## Summary", "", scrub(options.summary).trim(), "");
    }
    lines.push("## Signatures", "");
    for (const entry of summary.signatures) {
        lines.push(`### ${entry.provider}/${entry.model}`);
        lines.push("");
        lines.push(`- failure: ${entry.kind.replaceAll("_", " ")}`);
        lines.push(`- count: ${entry.count} across ${entry.sessions} sessions`);
        lines.push(`- first seen: ${entry.firstSeenAt}`);
        lines.push(`- last seen: ${entry.lastSeenAt}`);
        lines.push("- last error:");
        lines.push("");
        lines.push("```");
        lines.push(scrub(entry.lastDetail));
        lines.push("```");
        lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

export function failureReportOneshotInput(
    records: readonly ModelFailureRecord[],
    home?: string,
): string {
    const summary: ModelFailureSummary = summariseModelFailures(records);
    return summary.signatures.map((entry) =>
        [
            `model: ${entry.provider}/${entry.model}`,
            `failure: ${entry.kind.replaceAll("_", " ")}`,
            `count: ${entry.count}`,
            `error: ${sanitizeReportText(entry.lastDetail, home)}`,
        ].join("\n")
    ).join("\n\n");
}

export function failureReportFilename(at: Date): string {
    return `failures-${at.toISOString().replaceAll(/[:.]/g, "-")}.md`;
}

export function writeFailureReport(
    directory: string,
    contents: string,
    at: Date,
): string {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, failureReportFilename(at));
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
    return path;
}
