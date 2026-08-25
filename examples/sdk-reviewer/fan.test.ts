import { expect, test } from "bun:test";

import { Vera } from "../../index.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../../test/support/faux-adapter.ts";
import {
    CORRECTNESS_INSTRUCTIONS,
    REFUTER_INSTRUCTIONS,
    REPRODUCTION_INSTRUCTIONS,
    SECURITY_INSTRUCTIONS,
    type ReviewLensName,
} from "./lenses.ts";
import {
    runAdversarialReview,
    type ReviewRuntime,
} from "./review.ts";
import type { ReviewFinding } from "./review-schema.ts";
import type { PreparedReview } from "./target-snapshot.ts";

test("D1 three lenses run and their findings merge", async () => {
    const adapter = new RoutingAdapter((role) =>
        role === "refuter"
            ? verdict(false, "The evidence survives.")
            : findings([finding(`${role} finding`)])
    );

    const result = await reviewWith(adapter);

    expect(adapter.roles.filter((role) => role !== "refuter").sort()).toEqual([
        "correctness",
        "reproduction",
        "security",
    ]);
    expect(result.findings.map((row) => row.finding.summary).sort()).toEqual([
        "correctness finding",
        "reproduction finding",
        "security finding",
    ]);
});

test("D2 a refuted finding is dropped and a survivor is kept", async () => {
    const adapter = new RoutingAdapter((role, request) => {
        if (role === "correctness") {
            return findings([
                finding("drop this"),
                finding("keep this"),
            ]);
        }
        if (role !== "refuter") return findings([]);
        return requestText(request).includes("drop this")
            ? verdict(true, "An existing guard prevents it.")
            : verdict(false, "No guard prevents it.");
    });

    const result = await reviewWith(adapter);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.finding.summary).toBe("keep this");
    expect(result.findings[0]?.verdict).toEqual({
        refuted: false,
        reasoning: "No guard prevents it.",
    });
});

test("D3 the lenses differ", () => {
    const instructions = [
        CORRECTNESS_INSTRUCTIONS,
        SECURITY_INSTRUCTIONS,
        REPRODUCTION_INSTRUCTIONS,
    ];
    expect(new Set(instructions).size).toBe(3);
    for (let left = 0; left < instructions.length; left += 1) {
        for (let right = left + 1; right < instructions.length; right += 1) {
            expect(commonPrefixLength(
                instructions[left] ?? "",
                instructions[right] ?? "",
            )).toBeLessThan(24);
        }
    }
});

test("D4 the merge is not a vote", async () => {
    const adapter = new RoutingAdapter((role) => {
        if (role === "security") {
            return findings([finding("unique security defect")]);
        }
        if (role === "refuter") {
            return verdict(false, "The unique path is reachable.");
        }
        return findings([]);
    });

    const result = await reviewWith(adapter);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
        lens: "security",
        finding: { summary: "unique security defect" },
    });
});

test("D5 a failed lens does not sink the fan", async () => {
    const adapter = new RoutingAdapter((role) => {
        if (role === "security") return new Error("security lens unavailable");
        if (role === "refuter") return verdict(false, "The finding survives.");
        return findings([finding(`${role} finding`)]);
    });

    const result = await reviewWith(adapter);

    expect(result.outcome).toBe("completed");
    expect(result.findings.map((row) => row.lens).sort()).toEqual([
        "correctness",
        "reproduction",
    ]);
    expect(result.lensFailures).toEqual([{
        lens: "security",
        error: {
            kind: "model",
            message: "security lens unavailable",
        },
    }]);
    expect(result.report).toContain("Lens failures:");
    expect(result.report).toContain("security lens unavailable");
});

type ReviewRole = ReviewLensName | "refuter";
type RoutedOutput = Readonly<Record<string, unknown>> | Error;
type Route = (role: ReviewRole, request: ModelRequest) => RoutedOutput;

class RoutingAdapter implements ModelAdapter {
    readonly roles: ReviewRole[] = [];

    constructor(private readonly route: Route) {}

    stream(request: ModelRequest): ModelEventStream {
        const role = roleFromRequest(request);
        this.roles.push(role);
        const output = this.route(role, request);
        if (output instanceof Error) return failed(output, request.model);
        return new FauxAdapter([
            answer(JSON.stringify(output), role),
        ]).stream(request);
    }
}

async function reviewWith(adapter: ModelAdapter) {
    return runAdversarialReview({
        workspace: process.cwd(),
        target: { kind: "uncommitted" },
        task: "Preserve structured review behavior.",
    }, {
        prepare: async () => preparedReview(),
        createRuntime: async (): Promise<ReviewRuntime> => Vera.create({
            config: {
                schema_version: 1,
                provider: "faux",
                model: "reviewer",
                reasoning_effort: "high",
                approval_mode: "readonly",
            },
            workspace: process.cwd(),
            posture: "readonly",
            createAdapter: () => adapter,
        }),
    });
}

function preparedReview(): PreparedReview {
    return {
        target: { kind: "uncommitted" },
        snapshot: {
            label: "uncommitted",
            changedFiles: "M src/example.ts",
            patch: "diff --git a/src/example.ts b/src/example.ts",
            patchBytes: 48,
        },
        task: "Preserve structured review behavior.",
        prompt:
            "Selected target: uncommitted\n\nChanged files:\nM src/example.ts\n\nPatch:\ndiff --git a/src/example.ts b/src/example.ts",
    };
}

function roleFromRequest(request: ModelRequest): ReviewRole {
    const systemPrompt = request.systemPrompt;
    if (systemPrompt === undefined) {
        throw new Error("Review request is missing a system prompt");
    }
    if (systemPrompt.includes(CORRECTNESS_INSTRUCTIONS)) {
        return "correctness";
    }
    if (systemPrompt.includes(SECURITY_INSTRUCTIONS)) return "security";
    if (systemPrompt.includes(REPRODUCTION_INSTRUCTIONS)) {
        return "reproduction";
    }
    if (systemPrompt.includes(REFUTER_INSTRUCTIONS)) return "refuter";
    throw new Error("Unknown review role");
}

function requestText(request: ModelRequest): string {
    return JSON.stringify(request.messages);
}

function finding(summary: string): ReviewFinding {
    return {
        summary,
        severity: "high",
        file: "src/example.ts",
        line: 7,
        mechanism: `${summary} reaches the changed branch.`,
        evidence: `The target contains evidence for ${summary}.`,
        suggestedFix: "Restore the guard.",
    };
}

function findings(values: readonly ReviewFinding[]): Readonly<Record<string, unknown>> {
    return { findings: values };
}

function verdict(
    refuted: boolean,
    reasoning: string,
): Readonly<Record<string, unknown>> {
    return { refuted, reasoning };
}

function answer(text: string, role: ReviewRole): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "test", model: role },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function failed(error: Error, model: string): ModelEventStream {
    const stream = new ModelEventStream();
    queueMicrotask(() => {
        stream.push({ type: "start" });
        stream.push({
            type: "error",
            error,
            message: {
                role: "assistant",
                content: [],
                source: { provider: "faux", api: "test", model },
                usage: emptyUsage(),
                stopReason: "error",
                errorMessage: error.message,
            },
        });
    });
    return stream;
}

function commonPrefixLength(left: string, right: string): number {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
}
