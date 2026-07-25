import { expect, test } from "bun:test";

import {
    BUILT_IN_PERMISSION_PROFILES,
    decideToolPermission,
    extractPermissionActions,
    inspectPermissions,
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

test("redirects outside the workspace are never routine", () => {
    // Regression: redirect targets were resolved against the workspace instead
    // of the shell, so `~/notes.md` became `<workspace>/~/notes.md` and was
    // treated as a routine inside-workspace write.
    for (
        const command of [
            "printf hi > ~/notes.md",
            "cat README.md > ~/notes.md",
            "printf hi >> ~/notes.md",
            "printf hi > /Users/nash/notes.md",
        ]
    ) {
        expect(decide("auto", bash(command)).behavior).toBe("review");
        expect(decide("ask", bash(command)).behavior).toBe("ask");
    }
    expect(
        extractPermissionActions({
            toolCall: bash("printf hi > ~/notes.md"),
            workspace,
            homeDirectory,
        }),
    ).toEqual([{
        tool: "bash",
        verb: "write",
        path: "/Users/nash/notes.md",
        scope: "outside_workspace",
        executable: "shell_redirect",
    }]);
});

test("inert redirect targets never escalate past a routine read", () => {
    for (
        const command of [
            "cat README.md 2>/dev/null",
            "echo hi > /dev/null",
            "printf x 2>&1",
        ]
    ) {
        expect(decide("auto", bash(command)).behavior).toBe("allow");
    }
});

test("a redirect to a real path still escalates (regression guard)", () => {
    expect(decide("auto", bash("cat README.md > /tmp/out.txt")).behavior)
        .not.toBe("allow");
});

test("a redirect after cd is resolved against that directory", () => {
    expect(decide("auto", bash("cd /tmp && printf hi > notes.txt")).behavior)
        .toBe("review");
    expect(
        extractPermissionActions({
            toolCall: bash("cd /tmp && printf hi > notes.txt"),
            workspace,
            homeDirectory,
        }).map((action) => action.path),
    ).toEqual([undefined, "/tmp/notes.txt"]);
});

test("targets Vera cannot resolve become unknown actions, not guessed paths", () => {
    for (
        const command of [
            "printf hi > $OUT",
            "printf hi > \"$(mktemp)\"",
            "rm -rf $BUILD_DIR",
            "cd \"$WORK\" && printf hi > notes.txt",
        ]
    ) {
        const actions = extractPermissionActions({
            toolCall: bash(command),
            workspace,
            homeDirectory,
        });
        expect(actions.every((action) => action.path === undefined)).toBe(true);
        expect(actions.some((action) => action.verb === "unknown")).toBe(true);
        expect(decide("auto", bash(command)).behavior).toBe("review");
    }
});

test("a routine action never allows the rest of the tool call", () => {
    // A recognized read plus an unresolved command still falls back.
    expect(decide("auto", bash("cat README.md && bun install")).behavior)
        .toBe("review");
    expect(decide("auto", bash("cat README.md | tee notes.txt")).behavior)
        .toBe("review");
});

test("any tool with declared path inputs is gated the same as read/write", () => {
    // read/write/edit no longer get special-cased by name inside the engine;
    // they are gated purely through their declared permissionInputs, the
    // same seam any future tool goes through.
    for (const name of ["read", "write", "edit"]) {
        expect(decide(name === "write" ? "auto" : "auto", toolCall(name, {
            path: "../outside/file.txt",
            content: "x",
            edits: [],
        })).behavior).toBe(name === "read" ? "allow" : "review");
    }
    expect(decide("auto", toolCall("write", {
        path: "inside.txt",
        content: "x",
    })).behavior).toBe("allow");
});

test("a structured tool call missing its declared path input falls to review, not allow", () => {
    expect(decide("auto", toolCall("write", { content: "x" })).behavior)
        .toBe("review");
    expect(decide("ask", toolCall("write", { content: "x" })).behavior)
        .toBe("ask");
});

test("custom profiles use the same ordered evaluator", () => {
    const permissionProfiles = {
        quiet: {
            name: "quiet",
            defaultOutcome: "review" as const,
            reviewerProfile: "careful",
            rules: [{
                name: "quiet.rules.0",
                when: { tool: "bash", executable: "curl" },
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

test("an unresolved cd leaves later relative targets unrecognized", () => {
    // The guard refuses positively recognized targets only. It cannot know
    // where `cd "$DIR"` landed, so `*` is no longer the workspace contents.
    for (
        const command of [
            "cd \"$DIR\" && rm -rf *",
            "cd $DIR && rm -rf .",
            "cd \"$(mktemp -d)\" && rm -rf *",
        ]
    ) {
        expect(decide("full_access", bash(command)).behavior).toBe("allow");
        expect(decide("auto", bash(command)).behavior).toBe("review");
        expect(decide("ask", bash(command)).behavior).toBe("ask");
    }
});

test("an unresolved cd still leaves absolute targets recognized", () => {
    for (
        const command of [
            "cd \"$DIR\" && rm -rf /",
            "cd \"$DIR\" && rm -rf ~",
            "cd \"$DIR\" && rm -rf /Users/nash/Projects/vera",
        ]
    ) {
        const decision = decide("full_access", bash(command));
        expect(decision.behavior).toBe("deny");
        if (decision.behavior === "deny") {
            expect(decision.source).toBe("accident_guard");
        }
    }
});

test("bash extraction preserves independent pipeline effects", () => {
    expect(actions("curl https://example.com | tee notes.txt")).toEqual([
        { tool: "bash", verb: "unknown", executable: "curl" },
        { tool: "bash", verb: "unknown", executable: "tee" },
    ]);
});

test("git operations become named actions", () => {
    expect(actions("git fetch origin")[0]?.operation).toBe("git.fetch");
    expect(actions("git push origin main")[0]?.operation).toBe("git.push");
    expect(actions("git commit -m test")[0]).toEqual({
        tool: "bash",
        verb: "write",
        operation: "git.commit",
        executable: "git",
    });
});

test("session grants lower matching ask and review outcomes to allow", () => {
    const request = decide("ask", bash("git push origin main"));
    const proposals = permissionGrantProposals(request);
    expect(proposals).toEqual([{
        kind: "action",
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
        actions: [{ outcome: "allow", grant: "grant-1:0" }],
    });
    expect(decide("ask", bash("git fetch origin"), grants).behavior)
        .toBe("ask");
});

test("a path grant covers that subtree and no sibling", () => {
    const grants: PermissionGrant[] = [{
        id: "grant-1:0",
        kind: "action",
        when: { verb: "delete", path: "/Users/nash/Projects/other-repo" },
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
        kind: "action",
        when: { verb: "delete" },
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

test("permission inspection snapshots the selected profile and active grants", () => {
    const grants: PermissionGrant[] = [{
        id: "grant-1:0",
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }];
    expect(inspectPermissions("auto", {}, grants)).toMatchObject({
        selected: {
            name: "auto",
            defaultOutcome: "review",
            reviewerProfile: "default",
        },
        availableProfiles: ["full_access", "ask", "auto"],
        activeGrants: grants,
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

function actions(command: string) {
    return extractPermissionActions({
        toolCall: bash(command),
        workspace,
        homeDirectory,
    });
}

function bash(command: string): HookToolCall {
    return toolCall("bash", { command });
}

function toolCall(name: string, input: JsonObject): HookToolCall {
    return { id: "call_1", name, input };
}
