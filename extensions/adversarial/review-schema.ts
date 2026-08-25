import type { AgentOutputSchema } from "../../src/sdk/agent.ts";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
    readonly summary: string;
    readonly severity: ReviewSeverity;
    readonly file?: string;
    readonly line?: number;
    readonly mechanism: string;
    readonly evidence: string;
    readonly suggestedFix?: string;
}

export interface ReviewFindingsOutput {
    readonly findings: readonly ReviewFinding[];
}

export interface RefutationVerdict {
    readonly refuted: boolean;
    readonly reasoning: string;
}

export const FINDINGS_SCHEMA: AgentOutputSchema<ReviewFindingsOutput> = {
    parse: parseFindings,
};

export const VERDICT_SCHEMA: AgentOutputSchema<RefutationVerdict> = {
    parse: parseVerdict,
};

function parseFindings(value: unknown): ReviewFindingsOutput {
    const object = record(value, "output");
    exactKeys(object, ["findings"], "output");
    if (!Array.isArray(object.findings)) {
        throw new Error("output.findings must be an array");
    }
    return {
        findings: object.findings.map((finding, index) =>
            parseFinding(finding, `output.findings[${index}]`)
        ),
    };
}

function parseFinding(value: unknown, path: string): ReviewFinding {
    const object = record(value, path);
    exactKeys(object, [
        "summary",
        "severity",
        "file",
        "line",
        "mechanism",
        "evidence",
        "suggestedFix",
    ], path);
    const severity = text(object.severity, `${path}.severity`);
    if (!isSeverity(severity)) {
        throw new Error(
            `${path}.severity must be critical, high, medium, or low`,
        );
    }
    const line = object.line;
    if (
        line !== undefined
        && (!Number.isSafeInteger(line) || (line as number) < 1)
    ) {
        throw new Error(`${path}.line must be a positive integer`);
    }
    return {
        summary: text(object.summary, `${path}.summary`),
        severity,
        ...(object.file === undefined
            ? {}
            : { file: text(object.file, `${path}.file`) }),
        ...(line === undefined ? {} : { line: line as number }),
        mechanism: text(object.mechanism, `${path}.mechanism`),
        evidence: text(object.evidence, `${path}.evidence`),
        ...(object.suggestedFix === undefined
            ? {}
            : {
                suggestedFix: text(
                    object.suggestedFix,
                    `${path}.suggestedFix`,
                ),
            }),
    };
}

function parseVerdict(value: unknown): RefutationVerdict {
    const object = record(value, "output");
    exactKeys(object, ["refuted", "reasoning"], "output");
    if (typeof object.refuted !== "boolean") {
        throw new Error("output.refuted must be a boolean");
    }
    return {
        refuted: object.refuted,
        reasoning: text(object.reasoning, "output.reasoning"),
    };
}

function record(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${path} must be a non-empty string`);
    }
    return value.trim();
}

function exactKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown !== undefined) {
        throw new Error(`${path}.${unknown} is not part of the schema`);
    }
}

function isSeverity(value: string): value is ReviewSeverity {
    return value === "critical"
        || value === "high"
        || value === "medium"
        || value === "low";
}
