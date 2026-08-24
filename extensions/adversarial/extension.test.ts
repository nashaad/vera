import { expect, test } from "bun:test";

import { activate } from "./extension.ts";
import type {
    VeraExtensionApi,
    VeraExtensionCommandSpec,
    VeraExtensionToolSpec,
} from "../../src/sdk/extensions.ts";
import type { AdversarialReviewResult } from "./review.ts";

test("command and top-level tool are thin adapters over one review function", async () => {
    let command: VeraExtensionCommandSpec | undefined;
    let tool: VeraExtensionToolSpec | undefined;
    const targets: unknown[] = [];
    activate({
        commands: { register: (spec) => command = spec },
        tools: { register: (spec) => tool = spec },
    } as VeraExtensionApi, {
        async review(request) {
            targets.push(request.target);
            return completed();
        },
    });

    expect(tool).toMatchObject({
        name: "adversarial_review",
        invocation: "top_level",
        permissionOperation: "adversarial.review",
    });
    expect(await command?.run({
        argumentsText: "--commit abcdef1",
        workspace: "/work",
        signal: new AbortController().signal,
    })).toEqual({ kind: "text", text: "review" });
    expect(await tool?.run({
        input: { target: "base", value: "main" },
        workspace: "/work",
        signal: new AbortController().signal,
    })).toEqual({ output: "review", isError: false });
    expect(targets).toEqual([
        { kind: "commit", value: "abcdef1" },
        { kind: "base", value: "main" },
    ]);

    expect(await command?.run({
        argumentsText: "--prompt do-evil",
        workspace: "/work",
        signal: new AbortController().signal,
    })).toMatchObject({ kind: "notice", level: "error" });
    expect(targets).toHaveLength(2);
});

function completed(): AdversarialReviewResult {
    return {
        outcome: "completed",
        report: "review",
        target: { kind: "uncommitted" },
        changedFiles: "M file.ts",
        patchBytes: 12,
        model: { provider: "faux", model: "reviewer" },
        substitutions: [],
    };
}
