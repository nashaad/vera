import { expect, test } from "bun:test";

import type { ToolCallContent } from "../../src/model/types.ts";
import {
    executeToolHandler,
    toolDefinitionsForCapabilities,
} from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const runtime = new ToolRuntime("/workspace");
const signal = new AbortController().signal;

test("ask_user is exposed only with user-interaction capability", () => {
    const withoutInteraction = toolDefinitionsForCapabilities([])
        .map((tool) => tool.name);
    const withEffectsOnly = toolDefinitionsForCapabilities([
        "spawn_subagent",
        "spawn_async_subagent",
    ]).map((tool) => tool.name);
    const withInteraction = toolDefinitionsForCapabilities([], true)
        .map((tool) => tool.name);

    expect(withoutInteraction).not.toContain("ask_user");
    expect(withEffectsOnly).not.toContain("ask_user");
    expect(withInteraction).toContain("ask_user");
});

test("ask_user accepts the two-choice and nine-choice boundaries", async () => {
    const twoChoices = await askUser({
        question: "Choose a direction",
        choices: choices(2),
    });
    const nineChoices = await askUser({
        question: "Choose a number",
        choices: choices(9),
    });

    expect(twoChoices).toMatchObject({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            choices: choices(2),
        },
    });
    expect(nineChoices).toMatchObject({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            choices: choices(9),
        },
    });
});

test("ask_user rejects fewer than two or more than nine choices", async () => {
    const oneChoice = await askUser({
        question: "Choose",
        choices: choices(1),
    });
    const tenChoices = await askUser({
        question: "Choose",
        choices: choices(10),
    });

    expect(oneChoice).toEqual({
        kind: "output",
        output: "ask_user requires two to nine choices",
        isError: true,
    });
    expect(tenChoices).toEqual({
        kind: "output",
        output: "ask_user requires two to nine choices",
        isError: true,
    });
});

test("ask_user rejects blank questions, IDs, and labels", async () => {
    const blankQuestion = await askUser({
        question: " \n ",
        choices: choices(2),
    });
    const blankId = await askUser({
        question: "Choose",
        choices: [
            { id: " ", label: "First" },
            { id: "second", label: "Second" },
        ],
    });
    const blankLabel = await askUser({
        question: "Choose",
        choices: [
            { id: "first", label: "First" },
            { id: "second", label: "\t" },
        ],
    });

    expect(blankQuestion).toMatchObject({
        output: "ask_user requires a non-empty question",
        isError: true,
    });
    expect(blankId).toMatchObject({
        output: "ask_user requires a non-empty choice 1 ID",
        isError: true,
    });
    expect(blankLabel).toMatchObject({
        output: "ask_user requires a non-empty choice 2 label",
        isError: true,
    });
});

test("ask_user rejects duplicate choice IDs", async () => {
    const result = await askUser({
        question: "Choose",
        choices: [
            { id: "same", label: "First" },
            { id: "same", label: "Second" },
        ],
    });

    expect(result).toEqual({
        kind: "output",
        output: "ask_user choice IDs must be unique",
        isError: true,
    });
});

test("ask_user rejects unknown choice fields", async () => {
    const result = await askUser({
        question: "Choose",
        choices: [
            { id: "first", label: "First", tooltip: "Extra detail" },
            { id: "second", label: "Second" },
        ],
    });

    expect(result).toEqual({
        kind: "output",
        output:
            "ask_user choice 1 must contain only id, label, description,"
                + " preview, and recommended",
        isError: true,
    });
});

test("ask_user preserves model-provided stable choice IDs", async () => {
    const result = await askUser({
        question: "How should Vera continue?",
        choices: [
            { id: "continue_current", label: "Continue" },
            { id: "start_over", label: "Start over" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "How should Vera continue?",
            choices: [
                { id: "continue_current", label: "Continue" },
                { id: "start_over", label: "Start over" },
            ],
        },
    });
});

function choices(count: number): readonly Record<string, string>[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `choice_${index + 1}`,
        label: `Choice ${index + 1}`,
    }));
}

function askUser(input: Readonly<Record<string, unknown>>) {
    return executeToolHandler(
        toolCall(input),
        runtime,
        signal,
    );
}

function toolCall(
    input: Readonly<Record<string, unknown>>,
): ToolCallContent {
    return {
        type: "tool_call",
        id: "call_ask_user",
        name: "ask_user",
        input,
    };
}

test("ask_user keeps a choice preview verbatim", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", preview: "  \u250c\u2500\u2500\u2510\n  \u2514\u2500\u2500\u2518\n" },
            { id: "narrow", label: "Narrow" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "Which layout?",
            choices: [
                { id: "wide", label: "Wide", preview: "  \u250c\u2500\u2500\u2510\n  \u2514\u2500\u2500\u2518\n" },
                { id: "narrow", label: "Narrow" },
            ],
        },
    });
});

test("ask_user carries a choice description through", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", description: "Two columns side by side." },
            { id: "narrow", label: "Narrow" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "Which layout?",
            choices: [
                {
                    id: "wide",
                    label: "Wide",
                    description: "Two columns side by side.",
                },
                { id: "narrow", label: "Narrow" },
            ],
        },
    });
});

test("ask_user treats a blank description or preview as omitted", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", description: "   ", preview: "" },
            { id: "narrow", label: "Narrow", description: "", preview: "\n" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "Which layout?",
            choices: [
                { id: "wide", label: "Wide" },
                { id: "narrow", label: "Narrow" },
            ],
        },
    });
});

test("ask_user rejects a non-string description or preview", async () => {
    const badDescription = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", description: 3 },
            { id: "narrow", label: "Narrow" },
        ],
    });
    const badPreview = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", preview: null },
            { id: "narrow", label: "Narrow" },
        ],
    });

    expect(badDescription).toEqual({
        kind: "output",
        output: "ask_user requires a non-empty choice 1 description",
        isError: true,
    });
    expect(badPreview).toEqual({
        kind: "output",
        output: "ask_user requires a non-empty choice 1 preview",
        isError: true,
    });
});

test("ask_user keeps one recommended choice and lists it first", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide" },
            {
                id: "narrow",
                label: "Narrow",
                recommended: true,
            },
            { id: "stacked", label: "Stacked" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "Which layout?",
            choices: [
                { id: "narrow", label: "Narrow", recommended: true },
                { id: "wide", label: "Wide" },
                { id: "stacked", label: "Stacked" },
            ],
        },
    });
});

test("ask_user treats recommended false as omitted", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", recommended: false },
            { id: "narrow", label: "Narrow" },
        ],
    });

    expect(result).toEqual({
        kind: "interaction",
        interaction: {
            type: "ask_user",
            question: "Which layout?",
            choices: [
                { id: "wide", label: "Wide" },
                { id: "narrow", label: "Narrow" },
            ],
        },
    });
});

test("ask_user rejects a second recommended choice", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", recommended: true },
            { id: "narrow", label: "Narrow", recommended: true },
        ],
    });

    expect(result).toEqual({
        kind: "output",
        output: "ask_user allows at most one recommended choice",
        isError: true,
    });
});

test("ask_user rejects a non-boolean recommended flag", async () => {
    const result = await askUser({
        question: "Which layout?",
        choices: [
            { id: "wide", label: "Wide", recommended: "yes" },
            { id: "narrow", label: "Narrow" },
        ],
    });

    expect(result).toEqual({
        kind: "output",
        output: "ask_user choice 1 recommended must be a boolean",
        isError: true,
    });
});
