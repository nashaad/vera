import { expect, test } from "bun:test";

import {
    defineAgent,
    Vera,
    type AgentDefinition,
    type TranscriptEntry,
} from "../../index.ts";

test("the public transcript type includes readable reasoning", () => {
    const entry: TranscriptEntry = { kind: "reasoning", text: "follow the stars" };
    expect(entry).toEqual({ kind: "reasoning", text: "follow the stars" });
});

test("the package root exports embedded definitions and runtime", () => {
    const definition: AgentDefinition = defineAgent({
        name: "reviewer",
        instructions: "Review the supplied change.",
        tools: ["read", "grep"],
        posture: "readonly",
    });

    expect(definition.name).toBe("reviewer");
    expect(definition.tools).toEqual(["read", "grep"]);
    expect(typeof Vera.create).toBe("function");
    expect(typeof Vera.run).toBe("function");
});
