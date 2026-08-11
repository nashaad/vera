import { beforeAll, expect, test } from "bun:test";

import { initBashParser } from "../../src/tools/bash-parser.ts";
import {
    BUILT_IN_PERMISSION_MODES,
    CORE_PERMISSION_OPERATIONS,
    decideToolPermission,
    extractPermissionActions,
    inspectPermissions,
    permissionGrantProposals,
    type ApprovalMode,
    type PermissionGrant,
} from "../../src/engine/permissions.ts";
import type { HookToolCall, JsonObject } from "../../src/sdk/hooks.ts";
import { skillScriptTool } from "../../src/skills/script.ts";

const workspace = "/Users/nash/Projects/vera";
const homeDirectory = "/Users/nash";

// `runTurn` awaits this in production. The classifier stays synchronous, so
// without the parser ready every bash command classifies as unknown.
beforeAll(async () => {
    await initBashParser();
});

test("built-in profiles have the accepted defaults", () => {
    expect(BUILT_IN_PERMISSION_MODES.full_access).toEqual({
        name: "full_access",
        rules: [],
        defaultOutcome: "allow",
    });
    expect(BUILT_IN_PERMISSION_MODES.ask.defaultOutcome).toBe("ask");
    expect(BUILT_IN_PERMISSION_MODES.auto.defaultOutcome)
        .toBe("review");
    expect(BUILT_IN_PERMISSION_MODES.readonly.defaultOutcome).toBe("deny");
});

test("skill scripts use each profile's ordinary unknown-execution policy", () => {
    const call = toolCall("skill_script", {
        skill: "inspect",
        script: "scripts/inspect.sh",
    });
    for (const [mode, behavior] of [
        ["readonly", "deny"],
        ["ask", "ask"],
        ["auto", "review"],
        ["full_access", "allow"],
    ] as const) {
        expect(decideToolPermission(mode, call, workspace, [], {
            homeDirectory,
            extensionTools: [skillScriptTool],
        }).behavior).toBe(behavior);
    }
});

test("readonly allows structured reads but denies bash and mutation", () => {
    expect(decide("readonly", toolCall("read", { path: "README.md" })).behavior)
        .toBe("allow");
    expect(decide("readonly", bash("git status --short")).behavior).toBe("deny");
    expect(decide("readonly", bash("cat README.md")).behavior).toBe("deny");
    expect(decide("readonly", toolCall("write", {
        path: "notes.txt",
        content: "hello",
    })).behavior).toBe("deny");
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

test("agent launches are recognized routine operations", () => {
    for (const name of ["subagent", "async_subagent"]) {
        const toolCall = {
            id: `call-${name}`,
            name,
            input: { description: "Inspect the repository" },
        };
        expect(
            extractPermissionActions({
                toolCall,
                workspace,
                homeDirectory,
            }),
        ).toEqual([{
            tool: name,
            verb: "unknown",
            operation: "agent.spawn",
        }]);
        expect(decideToolPermission(
            "ask",
            toolCall,
            workspace,
            [],
            { homeDirectory },
        ).behavior).toBe("allow");
        expect(decideToolPermission(
            "auto",
            toolCall,
            workspace,
            [],
            { homeDirectory },
        ).behavior).toBe("allow");
    }
});

test("agent messages are recognized routine operations", () => {
    for (const name of ["message_subagent", "notify_parent"]) {
        const input: Record<string, string> = name === "message_subagent"
            ? { subagent_id: "child-1", message: "Check the parser" }
            : { message: "I need a decision" };
        const toolCall = {
            id: `call-${name}`,
            name,
            input,
        };
        expect(
            extractPermissionActions({
                toolCall,
                workspace,
                homeDirectory,
            }),
        ).toEqual([{
            tool: name,
            verb: "unknown",
            operation: "agent.message",
        }]);
        expect(decideToolPermission(
            "ask",
            toolCall,
            workspace,
            [],
            { homeDirectory },
        ).behavior).toBe("allow");
    }
});

test("explicit inbox reads are recognized routine operations", () => {
    const toolCall = {
        id: "call-inbox",
        name: "agent_inbox",
        input: {},
    };
    expect(extractPermissionActions({
        toolCall,
        workspace,
        homeDirectory,
    })).toEqual([{
        tool: "agent_inbox",
        verb: "unknown",
        operation: "agent.inbox",
    }]);
    expect(decideToolPermission(
        "ask",
        toolCall,
        workspace,
        [],
        { homeDirectory },
    ).behavior).toBe("allow");
});

test("2>&1 duplicates an fd rather than writing to a file named 1", () => {
    expect(
        extractPermissionActions({
            toolCall: bash("cat README.md 2>&1"),
            workspace,
            homeDirectory,
        }),
    ).toEqual([{ tool: "bash", verb: "read", executable: "cat" }]);
});

test(">& with a non-numeric target is a write, not an fd duplication", () => {
    // `cmd >& file` is bash's older spelling of `cmd &> file`, so the number is
    // what distinguishes a duplication from a file it creates.
    expect(
        extractPermissionActions({
            toolCall: bash("cat README.md >& /tmp/out.txt"),
            workspace,
            homeDirectory,
        }),
    ).toContainEqual({
        tool: "bash",
        verb: "write",
        path: "/tmp/out.txt",
        scope: "outside_workspace",
        executable: "shell_redirect",
    });
});

test("a hidden argument defeats the read-only classifier", () => {
    // `sed "$FLAGS" notes.md` looks argument-free, but FLAGS=-i makes it a write.
    expect(
        extractPermissionActions({
            toolCall: bash(`sed "$FLAGS" notes.md`),
            workspace,
            homeDirectory,
        }),
    ).toEqual([{ tool: "bash", verb: "unknown", executable: "sed" }]);
});

test("a quoted literal path is still resolved, since quoting is not expansion", () => {
    expect(
        extractPermissionActions({
            toolCall: bash(`printf hi > "/tmp/my notes.txt"`),
            workspace,
            homeDirectory,
        }),
    ).toEqual([{
        tool: "bash",
        verb: "write",
        path: "/tmp/my notes.txt",
        scope: "outside_workspace",
        executable: "shell_redirect",
    }]);
});

test("a redirect on a pipeline is attributed once, to the last stage", () => {
    expect(
        extractPermissionActions({
            toolCall: bash("cat README.md | tee a.txt > /tmp/other.txt"),
            workspace,
            homeDirectory,
        }).filter((action) => action.executable === "shell_redirect"),
    ).toEqual([{
        tool: "bash",
        verb: "write",
        path: "/tmp/other.txt",
        scope: "outside_workspace",
        executable: "shell_redirect",
    }]);
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

test("reading an obvious secret file is denied by default", () => {
    for (
        const path of [
            ".env",
            "config/.env",
            "id_rsa",
            "keys/id_rsa",
            "server.pem",
        ]
    ) {
        for (const mode of ["ask", "auto"] as const) {
            const decision = decide(mode, toolCall("read", { path }));
            expect(decision.behavior).toBe("deny");
            if (decision.behavior === "deny") {
                expect(decision.source).toBe("mode");
            }
        }
    }
});

// The deny list covers `.env` exactly, not `.env.*`. Suffixed variants are
// too often a checked-in placeholder (`.env.example`) or a file the user
// wants read, and this list is hygiene rather than a security boundary, so
// it stays small instead of growing exceptions to cover its own overreach.
test("suffixed .env variants are not caught by the hygiene deny", () => {
    for (const path of [".env.example", ".env.local", ".env.production"]) {
        for (const mode of ["ask", "auto", "full_access"] as const) {
            expect(decide(mode, toolCall("read", { path })).behavior)
                .toBe("allow");
        }
    }
});

test("full_access is not subject to the secret-file hygiene deny", () => {
    expect(decide("full_access", toolCall("read", { path: ".env" })).behavior)
        .toBe("allow");
});

test("the secret-file hygiene deny only applies to reads", () => {
    // Writing/creating a secret file goes through the normal write rules
    // (allowed inside the workspace) rather than being hard-denied.
    expect(decide("auto", toolCall("write", { path: ".env", content: "x" }))
        .behavior).toBe("allow");
    // Outside the workspace it still follows the ordinary write flow, not a
    // hard secret-file deny.
    expect(decide("auto", toolCall("write", {
        path: "../.env",
        content: "x",
    })).behavior).toBe("review");
});

test("a pathGlob predicate matches by basename in a custom profile", () => {
    const permissionModes = {
        no_yaml: {
            name: "no_yaml",
            defaultOutcome: "allow" as const,
            rules: [{
                name: "no_yaml.rules.0",
                when: { pathGlob: "*.yaml" },
                then: "deny" as const,
            }],
        },
    };
    const decision = decideToolPermission(
        "no_yaml",
        toolCall("read", { path: "config/settings.yaml" }),
        workspace,
        [],
        { homeDirectory, permissionModes },
    );
    expect(decision.behavior).toBe("deny");
    expect(decideToolPermission(
        "no_yaml",
        toolCall("read", { path: "config/settings.json" }),
        workspace,
        [],
        { homeDirectory, permissionModes },
    ).behavior).toBe("allow");
});

test("custom profiles use the same ordered evaluator", () => {
    const permissionModes = {
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
        { homeDirectory, permissionModes },
    ).behavior).toBe("allow");
    const decision = decideToolPermission(
        "quiet",
        bash("bun install"),
        workspace,
        [],
        { homeDirectory, permissionModes },
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

test("provably read-only git subcommands are routine reads", () => {
    for (
        const command of [
            "git log --oneline",
            "git status",
            "git diff HEAD~1",
            "git show HEAD",
            "git branch --list",
        ]
    ) {
        expect(actions(command)).toEqual([
            { tool: "bash", verb: "read", executable: "git" },
        ]);
        expect(decide("auto", bash(command)).behavior).toBe("allow");
    }
});

test("bounded sleep and clock reads do not require approval", () => {
    expect(actions("sleep 5 && date")).toEqual([
        { tool: "bash", verb: "read", executable: "sleep" },
        { tool: "bash", verb: "read", executable: "date" },
    ]);
    expect(decide("ask", bash("sleep 5 && date")).behavior).toBe("allow");
    expect(decide("ask", bash("sleep 2m && date +%s")).behavior).toBe("allow");
});

test("long sleeps and commands that may set the clock still require approval", () => {
    expect(decide("ask", bash("sleep 10m")).behavior).toBe("ask");
    expect(decide("ask", bash("date 010100002026")).behavior).toBe("ask");
});

test("git push is unaffected by the read allowlist", () => {
    expect(actions("git push origin main")[0]).toMatchObject({
        verb: "unknown",
        operation: "git.push",
    });
    expect(decide("auto", bash("git push origin main")).behavior)
        .toBe("review");
});

test("plain git branch (no --list) is not treated as read", () => {
    expect(actions("git branch")[0]).toEqual({
        tool: "bash",
        verb: "unknown",
        executable: "git",
    });
});

test("a read-leaning command with a mutating flag is not auto-allowed", () => {
    for (
        const command of [
            "find . -name *.log -exec rm {} \\;",
            "fd --exec rm",
            "sed -i s/foo/bar/ file.txt",
        ]
    ) {
        expect(decide("auto", bash(command)).behavior).not.toBe("allow");
    }
});

test("a mutating long flag is caught in --flag=value form too", () => {
    for (
        const command of [
            "sed --in-place=.bak s/foo/bar/ file.txt",
            "sed -i.bak s/foo/bar/ file.txt",
            "fd --exec=rm",
        ]
    ) {
        expect(decide("auto", bash(command)).behavior).not.toBe("allow");
    }
});

test("the same commands without the mutating flag are routine reads", () => {
    expect(decide("auto", bash("find . -name *.log")).behavior).toBe("allow");
    expect(decide("auto", bash("fd '\\.ts$'")).behavior).toBe("allow");
    expect(decide("auto", bash("sed -n 1,5p file.txt")).behavior).toBe("allow");
});

test("package-manager query subcommands are routine reads", () => {
    expect(decide("auto", bash("npm view left-pad")).behavior).toBe("allow");
    expect(decide("auto", bash("pip list")).behavior).toBe("allow");
    expect(decide("auto", bash("cargo tree")).behavior).toBe("allow");
});

test("package-manager mutating subcommands are unaffected", () => {
    expect(decide("auto", bash("npm install left-pad")).behavior)
        .toBe("review");
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
    const permissionModes = {
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
        { homeDirectory, permissionModes },
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
        availableModes: ["full_access", "ask", "auto", "readonly"],
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

test("scratch directory writes are routine when the scratch dir is known", () => {
    const scratchDir = "/tmp/vera/session-1";
    const calls = [
        toolCall("write", {
            path: `${scratchDir}/todo.md`,
            content: "next steps",
        }),
        bash(`echo hi > ${scratchDir}/notes.txt`),
    ];
    for (const mode of ["ask", "auto"] as const) {
        for (const call of calls) {
            expect(decideToolPermission(
                mode,
                call,
                workspace,
                [],
                { homeDirectory, scratchDir },
            ).behavior).toBe("allow");
            expect(decideToolPermission(
                mode,
                call,
                workspace,
                [],
                { homeDirectory },
            ).behavior).not.toBe("allow");
        }
    }
});

test("a path escaping the scratch directory keeps its outside scope", () => {
    const decision = decideToolPermission(
        "ask",
        toolCall("write", {
            path: "/tmp/vera/session-1/../other-session/todo.md",
            content: "x",
        }),
        workspace,
        [],
        { homeDirectory, scratchDir: "/tmp/vera/session-1" },
    );
    expect(decision.behavior).not.toBe("allow");
});

test("the session scratch dir is canonical so realpathed tool paths match it", async () => {
    const { sessionScratchDir } = await import("../../src/engine/run-turn.ts");
    const { realpathSync, rmSync } = await import("node:fs");
    const dir = sessionScratchDir("scratch-canonical-test");
    try {
        expect(realpathSync(dir)).toBe(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("memory writes are routine and named in the decision record", () => {
    const call = toolCall("memory_write", {
        scope: "project",
        file: "layout.md",
        content: "Engine never imports UI.",
        title: "Layout",
        hook: "where each layer lives",
    });
    for (const mode of ["ask", "auto"] as const) {
        const decision = decideToolPermission(
            mode,
            call,
            workspace,
            [],
            { homeDirectory },
        );
        expect(decision).toEqual({
            behavior: "allow",
            actions: [{
                action: {
                    tool: "memory_write",
                    verb: "unknown",
                    operation: "memory.write",
                },
                outcome: "allow",
                rule: "routine.memory_write",
            }],
        });
    }
});

test("memory.write is a configurable operation", () => {
    expect(CORE_PERMISSION_OPERATIONS.has("memory.write")).toBe(true);
});
