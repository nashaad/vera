import { expect, test } from "bun:test";

import { applyPermissionGrant } from "../../src/engine/permission-grants.ts";
import {
    decideToolPermission,
    permissionGrantProposals,
    type PermissionGrant,
} from "../../src/engine/permissions.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

test("@core browser eval needs its own operation and grant in every mode", () => {
    const browserEval: RegisteredTool = {
        definition: {
            name: "builtin_browser_eval",
            description: "Run a script in the page.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        permissionOperation: "desktop.browser.eval",
        async execute() {
            return { kind: "output", output: "", isError: false };
        },
    };
    const call: HookToolCall = { id: "call_1", name: "builtin_browser_eval", input: { script: "return document.title" } };
    const options = { homeDirectory, extensionTools: [browserEval] };
    for (const [mode, behavior] of [
        ["readonly", "deny"],
        ["ask", "ask"],
        ["auto", "review"],
        ["full_access", "allow"],
    ] as const) {
        expect(decideToolPermission(mode, call, workspace, [], options).behavior)
            .toBe(behavior);
    }
    const asked = decideToolPermission("ask", call, workspace, [], options);
    const browserGrant: PermissionGrant = {
        id: "browser",
        kind: "action",
        when: { operation: "desktop.browser" },
        scope: "session",
        lifetime: "session",
    };
    const evalGrant: PermissionGrant = { ...browserGrant, id: "eval", when: { operation: "desktop.browser.eval" } };
    const action = asked.actions[0]!;
    expect(applyPermissionGrant(action, [browserGrant])).toBe(action);
    expect(applyPermissionGrant(action, [evalGrant])).toMatchObject({
        outcome: "allow",
        grant: "eval",
    });
    expect(permissionGrantProposals(asked)).toEqual([
        { kind: "action", when: { operation: "desktop.browser.eval" }, scope: "session", lifetime: "session" },
    ]);
});
