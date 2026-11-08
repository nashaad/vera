import { expect, test } from "bun:test";

import {
    defineAgent,
    Vera,
    type AgentDefinition,
    type HookFailureOptions,
} from "../../index.ts";

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

test("extension hook failure options are available from the package root", () => {
    const options: HookFailureOptions = { onFailure: "deny" };
    expect(options.onFailure).toBe("deny");
});
