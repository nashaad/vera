import { beforeAll, expect, test } from "bun:test";

import {
    decideToolPermission,
    permissionGrantProposals,
    type PermissionGrant,
    type PermissionMode,
} from "../../src/engine/permissions.ts";
import type { HookToolCall, JsonObject } from "../../src/sdk/hooks.ts";
import { initBashParser } from "../../src/tools/bash-parser.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

// The fetch that asks here is one the routine rules would allow, so the mode
// allows reads and asks for every other action.
const fetchy: Readonly<Record<string, PermissionMode>> = {
    fetchy: {
        name: "fetchy",
        defaultOutcome: "ask" as const,
        rules: [{ name: "read", when: { verb: "read" }, then: "allow" as const }],
    },
};

beforeAll(async () => {
    await initBashParser();
});

test("a web fetch grant names the host", () => {
    const decisions = decide("fetchy", fetch("https://example.com/docs"), fetchy);
    expect(decisions.behavior).toBe("ask");
    expect(permissionGrantProposals(decisions).map((proposal) => proposal.when))
        .toEqual([{ operation: "web.fetch", host: "example.com" }]);
});

test("a web fetch grant allows its host and still asks another", () => {
    const grants = sessionGrants(decide(
        "fetchy",
        fetch("https://example.com/docs"),
        fetchy,
    ));
    expect(decide("fetchy", fetch("https://example.com/other"), fetchy, grants)
        .behavior).toBe("allow");
    expect(decide("fetchy", fetch("https://elsewhere.test/other"), fetchy, grants)
        .behavior).toBe("ask");
});

test("a saved preference that names a host allows only that host", () => {
    const preferences = [{
        id: "pref-host",
        when: { operation: "web.fetch", host: "example.com" },
        createdAt: "2026-11-16T12:00:00.000Z",
    }];
    const result = (url: string) => decideToolPermission(
        "fetchy",
        fetch(url),
        workspace,
        [],
        { homeDirectory, permissionModes: fetchy, permissionPreferences: preferences },
    ).behavior;
    expect(result("https://example.com/docs")).toBe("allow");
    expect(result("https://elsewhere.test/docs")).toBe("ask");
});

test("an older operation-only preference still matches every host", () => {
    const preferences = [{
        id: "pref-operation",
        when: { operation: "web.fetch" },
        createdAt: "2026-11-16T12:00:00.000Z",
    }];
    for (const url of ["https://example.com/docs", "https://elsewhere.test/docs"]) {
        expect(decideToolPermission(
            "fetchy",
            fetch(url),
            workspace,
            [],
            { homeDirectory, permissionModes: fetchy, permissionPreferences: preferences },
        ).behavior).toBe("allow");
    }
});

test("a web download grant names the host, and only when the action has one", () => {
    const named = decide(
        "ask",
        toolCall("web_download", { url: "https://example.com/map.png" }),
    );
    expect(permissionGrantProposals(named).map((proposal) => proposal.when))
        .toEqual([{ operation: "web.download", host: "example.com" }]);
    const unknown = decide(
        "ask",
        toolCall("web_download", { url: "not a url" }),
    );
    expect(permissionGrantProposals(unknown).map((proposal) => proposal.when))
        .toEqual([{ operation: "web.download" }]);
});

function decide(
    mode: string,
    call: HookToolCall,
    permissionModes: Readonly<Record<string, PermissionMode>> = {},
    grants: readonly PermissionGrant[] = [],
) {
    return decideToolPermission(
        mode,
        call,
        workspace,
        grants,
        {
            homeDirectory,
            ...(Object.keys(permissionModes).length === 0
                ? {}
                : { permissionModes }),
        },
    );
}

function sessionGrants(
    decisions: ReturnType<typeof decide>,
): readonly PermissionGrant[] {
    return permissionGrantProposals(decisions).map((proposal, index) => ({
        ...proposal,
        id: `grant-1:${index}`,
    }));
}

function fetch(url: string): HookToolCall {
    return toolCall("web_fetch", { url });
}

function toolCall(name: string, input: JsonObject): HookToolCall {
    return { id: "call_1", name, input };
}
