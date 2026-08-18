import { expect, test } from "bun:test";

import { narrowAgainstParent } from "../../src/engine/subagent.ts";
import {
    decideToolPermission,
    stricterToolPermission,
    type PermissionMode,
} from "../../src/engine/permissions.ts";

const CALL = {
    id: "1",
    name: "bash",
    input: { command: "rm -rf build" },
};

function decide(
    mode: string,
    modes: Readonly<Record<string, PermissionMode>>,
): ReturnType<typeof decideToolPermission> {
    return decideToolPermission(mode, CALL, "/tmp", [], {
        permissionModes: modes,
    });
}

test("the stricter of two outcomes wins, whichever side produced it", () => {
    // Custom modes on both sides: this is not an ordinal comparison of modes,
    // it is a comparison of what each one decided about one action.
    const modes: Record<string, PermissionMode> = {
        permissive: {
            name: "permissive",
            rules: [{ when: {}, outcome: "allow" }],
        } as unknown as PermissionMode,
        cautious: {
            name: "cautious",
            rules: [{ when: {}, outcome: "ask" }],
        } as unknown as PermissionMode,
    };
    const permissive = decide("permissive", modes);
    const cautious = decide("cautious", modes);

    expect(stricterToolPermission(permissive, cautious).behavior)
        .toBe(cautious.behavior);
    expect(stricterToolPermission(cautious, permissive).behavior)
        .toBe(cautious.behavior);
});

test("a tie goes to the child, whose agent was the one named", () => {
    const child = {
        behavior: "ask" as const,
        reason: "child",
        actions: [],
    };
    const parent = {
        behavior: "ask" as const,
        reason: "parent",
        actions: [],
    };
    expect(stricterToolPermission(child, parent).reason).toBe("child");
});

test("delegation narrows and never widens", () => {
    // An agent that grants a tool the parent does not have does not hand it
    // over. Absent on either side means "all of that side's", never "all".
    expect(narrowAgainstParent(
        { name: "child", instructions: "", tools: ["read", "write"] },
        { name: "parent", instructions: "", tools: ["read", "grep"] },
    ).tools).toEqual(["read"]);

    // Child unrestricted, parent restricted: the parent's list is the answer.
    expect(narrowAgainstParent(
        { name: "child", instructions: "" },
        { name: "parent", instructions: "", tools: ["read"] },
    ).tools).toEqual(["read"]);

    // Parent unrestricted: the child's own restriction stands.
    expect(narrowAgainstParent(
        { name: "child", instructions: "", skills: ["review"] },
        { name: "parent", instructions: "" },
    ).skills).toEqual(["review"]);

    // Neither restricted: still unrestricted, rather than an empty list.
    expect(narrowAgainstParent(
        { name: "child", instructions: "" },
        undefined,
    ).tools).toBeUndefined();
});
