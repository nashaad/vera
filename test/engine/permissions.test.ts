import { expect, test } from "bun:test";

import {
    BUILT_IN_PERMISSION_PROFILES,
    decideToolPermission,
    extractPermissionClaims,
    permissionGrantProposals,
    type ApprovalMode,
    type PermissionGrant,
} from "../../src/engine/permissions.ts";
import type { HookToolCall, JsonObject } from "../../src/sdk/hooks.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

test("built-in profiles have the accepted defaults", () => {
    expect(BUILT_IN_PERMISSION_PROFILES.full_access).toEqual({
        name: "full_access",
        rules: [],
        defaultOutcome: "allow",
    });
    expect(BUILT_IN_PERMISSION_PROFILES.ask.defaultOutcome).toBe("ask");
    expect(BUILT_IN_PERMISSION_PROFILES.auto.defaultOutcome)
        .toBe("review");
});

test("reads at every path scope are routine in every profile", () => {
    for (const mode of modes()) {
        for (const path of [
            "README.md",
            "../other-repo/README.md",
            "/Users/nash/Projects/Obsidian/Private/note.md",
        ]) {
            expect(decide(mode, toolCall("read", { path })).behavior)
                .toBe("allow");
        }
    }
});

test("exact workspace writes and local commits are routine", () => {
    for (const mode of modes()) {
        expect(decide(mode, toolCall("write", {
            path: "notes.txt",
            content: "hello",
        })).behavior).toBe("allow");
        expect(decide(mode, bash("git commit -m test")).behavior).toBe("allow");
    }
});

test("outside writes, network, sudo, and unknown bash use profile defaults", () => {
    const calls = [
        toolCall("write", {
            path: "../Obsidian/note.md",
            content: "hello",
        }),
        bash("git push origin main"),
        bash("curl https://example.com"),
        bash("sudo launchctl kickstart system/foo"),
        bash("bun test"),
    ];
    for (const call of calls) {
        expect(decide("ask", call).behavior).toBe("ask");
        expect(decide("auto", call).behavior).toBe("review");
        expect(decide("full_access", call).behavior).toBe("allow");
    }
});

test("recognized Bash redirects use the same workspace-write rule", () => {
    expect(decide(
        "auto",
        bash("printf hello > notes.txt"),
    ).behavior).toBe("allow");
    expect(decide(
        "auto",
        bash("printf hello > ../notes.txt"),
    ).behavior).toBe("review");
});

test("custom profiles use the same ordered evaluator", () => {
    const permissionProfiles = {
        quiet: {
            name: "quiet",
            defaultOutcome: "review" as const,
            reviewerProfile: "careful",
            rules: [{
                name: "quiet.rules.0",
                when: { capability: "network" as const },
                then: "allow" as const,
            }],
        },
    };
    expect(decideToolPermission(
        "quiet",
        bash("curl https://example.com"),
        workspace,
        [],
        { homeDirectory, permissionProfiles },
    ).behavior).toBe("allow");
    const decision = decideToolPermission(
        "quiet",
        bash("bun install"),
        workspace,
        [],
        { homeDirectory, permissionProfiles },
    );
    expect(decision).toMatchObject({
        behavior: "review",
        reviewerProfile: "careful",
    });
});

test("ordinary recursive deletion is reviewed rather than blanket denied", () => {
    for (const target of [
        ".venv",
        "node_modules",
        "dist",
        "../other-repo",
    ]) {
        expect(decide(
            "auto",
            bash(`rm -rf ${target}`),
        ).behavior).toBe("review");
        expect(decide(
            "full_access",
            bash(`rm -rf ${target}`),
        ).behavior).toBe("allow");
    }
});

test("accident guard refuses protected recursive deletion in every profile", () => {
    const commands = [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf ~/*",
        "rm -rf /Users/nash/Projects/vera",
        "rm -rf /Users/nash/Projects/vera/*",
        "rm -rf /Users/nash/Projects/*",
        "cd /Users/nash && rm -rf *",
    ];
    for (const mode of modes()) {
        for (const command of commands) {
            const decision = decide(mode, bash(command));
            expect(decision.behavior).toBe("deny");
            if (decision.behavior === "deny") {
                expect(decision.source).toBe("accident_guard");
            }
        }
    }
});

test("accident guard does not guess unresolved deletion targets", () => {
    expect(decide(
        "full_access",
        bash("rm -rf \"$(some-command)\""),
    ).behavior).toBe("allow");
});

test("bash extraction preserves independent pipeline effects", () => {
    const claims = extractPermissionClaims(
        bash("curl https://example.com | tee notes.txt"),
        workspace,
    );
    expect(claims.map((claim) => claim.capability)).toEqual([
        "network",
        "unknown",
    ]);
});

test("git operations become named claims", () => {
    expect(extractPermissionClaims(
        bash("git fetch origin"),
        workspace,
    )[0]?.operation).toBe("git.fetch");
    expect(extractPermissionClaims(
        bash("git push origin main"),
        workspace,
    )[0]?.operation).toBe("git.push");
    expect(extractPermissionClaims(
        bash("git commit -m test"),
        workspace,
    )[0]?.operation).toBe("git.commit");
});

test("session grants lower matching ask and review outcomes to allow", () => {
    const request = decide("ask", bash("git push origin main"));
    const proposals = permissionGrantProposals(request);
    expect(proposals).toEqual([{
        kind: "capability",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }]);
    const grants = proposals.map((proposal, index) => ({
        ...proposal,
        id: `grant-1:${index}`,
    }));
    const allowed = decide("ask", bash("git push origin main"), grants);
    expect(allowed).toMatchObject({
        behavior: "allow",
        claims: [{ outcome: "allow", grant: "grant-1:0" }],
    });
    expect(decide("ask", bash("git fetch origin"), grants).behavior)
        .toBe("ask");
});

test("a path grant covers that subtree and no sibling", () => {
    const grants: PermissionGrant[] = [{
        id: "grant-1:0",
        kind: "capability",
        when: {
            capability: "delete",
            path: "/Users/nash/Projects/other-repo",
            recursive: true,
        },
        scope: "session",
        lifetime: "session",
    }];
    expect(decide(
        "ask",
        bash("rm -rf /Users/nash/Projects/other-repo/build"),
        grants,
    ).behavior).toBe("allow");
    expect(decide(
        "ask",
        bash("rm -rf /Users/nash/Projects/different-repo"),
        grants,
    ).behavior).toBe("ask");
});

test("session grants cannot override profile denial or the accident guard", () => {
    const grants: PermissionGrant[] = [{
        id: "grant-1:0",
        kind: "capability",
        when: { capability: "delete" },
        scope: "session",
        lifetime: "session",
    }];
    const permissionProfiles = {
        locked: {
            name: "locked",
            defaultOutcome: "deny" as const,
            rules: [],
        },
    };
    expect(decideToolPermission(
        "locked",
        bash("rm -rf dist"),
        workspace,
        grants,
        { homeDirectory, permissionProfiles },
    ).behavior).toBe("deny");
    const guarded = decide(
        "full_access",
        bash("rm -rf /Users/nash/Projects/vera"),
        grants,
    );
    expect(guarded).toMatchObject({
        behavior: "deny",
        source: "accident_guard",
    });
});

function modes(): readonly ApprovalMode[] {
    return ["ask", "auto", "full_access"];
}

function decide(
    mode: ApprovalMode,
    call: HookToolCall,
    grants: readonly PermissionGrant[] = [],
) {
    return decideToolPermission(
        mode,
        call,
        workspace,
        grants,
        { homeDirectory },
    );
}

function bash(command: string): HookToolCall {
    return toolCall("bash", { command });
}

function toolCall(name: string, input: JsonObject): HookToolCall {
    return { id: "call_1", name, input };
}
