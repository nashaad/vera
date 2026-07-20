import { expect, test } from "bun:test";

import {
    commandPrefixForToolCall,
    decideToolPermission,
    type ApprovalMode,
} from "../../src/engine/permissions.ts";
import type { HookToolCall, JsonObject } from "../../src/sdk/hooks.ts";

const workspace = "/work/vera";

test("workspace file tools never need approval", () => {
    for (const mode of modes()) {
        for (const name of ["read", "write", "edit"]) {
            expect(decideToolPermission(
                mode,
                toolCall(name, { path: "notes.txt" }),
                workspace,
            )).toEqual({ behavior: "allow" });
        }
    }
});

test("recursive-force rm is denied in every mode", () => {
    for (const mode of modes()) {
        expect(decideToolPermission(
            mode,
            bash("rm -rf build"),
            workspace,
        )).toEqual({
            behavior: "deny",
            reason: "Blocked dangerous command: recursive-force rm is not allowed",
        });
    }
});

test("one simple bash command produces an exact token prefix", () => {
    expect(commandPrefixForToolCall(
        bash("git push origin main"),
    )).toEqual({ tokens: ["git", "push", "origin", "main"] });
    expect(commandPrefixForToolCall(
        bash("git status && git push"),
    )).toBeUndefined();
});

test("a session prefix allows matching commands but not shell compounds", () => {
    const prefix = { tokens: ["git", "push", "origin"] };
    expect(decideToolPermission(
        "ask",
        bash("git push origin main"),
        workspace,
        [prefix],
    )).toEqual({ behavior: "allow" });
    expect(decideToolPermission(
        "ask",
        bash("git push upstream main"),
        workspace,
        [prefix],
    ).behavior).toBe("ask");
    expect(decideToolPermission(
        "ask",
        bash("git push origin main && curl https://example.com"),
        workspace,
        [prefix],
    ).behavior).toBe("ask");
});

test("a session prefix cannot bypass the recursive-force rm denial", () => {
    expect(decideToolPermission(
        "ask",
        bash("rm -rf build"),
        workspace,
        [{ tokens: ["rm", "-rf", "build"] }],
    ).behavior).toBe("deny");
});

test("ask mode asks before every bash command", () => {
    expect(decideToolPermission(
        "ask",
        bash("bun test"),
        workspace,
    )).toEqual({
        behavior: "ask",
        reason: "Bash commands run with your full user permissions.",
    });
});

test("approve-for-me asks for likely network access", () => {
    for (const command of [
        "curl https://example.com",
        "git fetch origin",
        "git -C . fetch origin",
        "git ls-remote https://example.com/repo",
        "git remote update",
        "env curl https://example.com",
        "env -u HOME curl https://example.com",
        "bash -c 'curl https://example.com'",
        "bash -lc 'curl https://example.com'",
        "printf ok && wget https://example.com/file",
        "npm install left-pad",
        "npm i left-pad",
        "pnpm i",
        "yarn",
        "cargo add serde",
        "go install example.com/tool@latest",
        "uv sync",
        "git --git-dir .git fetch origin",
        "git --work-tree . pull",
    ]) {
        expect(decideToolPermission(
            "approve_for_me",
            bash(command),
            workspace,
        )).toEqual({
            behavior: "ask",
            reason: "This command may access the network.",
        });
    }
});

test("approve-for-me asks for likely outside-workspace access", () => {
    for (const command of [
        "cat ../secret.txt",
        "cat /etc/hosts",
        "printf value >~/.vera-note",
        "cp notes.txt --target-directory=/tmp",
        "bash -c 'cat /etc/hosts'",
        "cat $PWD/../secret.txt",
        "printf value 2>>/tmp/out",
        "cat 0</etc/hosts",
    ]) {
        expect(decideToolPermission(
            "approve_for_me",
            bash(command),
            workspace,
        )).toEqual({
            behavior: "ask",
            reason: "This command may access a path outside the workspace.",
        });
    }
});

test("approve-for-me allows ordinary workspace commands", () => {
    for (const command of [
        "bun test",
        "git status --short",
        "git show fetch",
        "mkdir -p build && cp notes.txt build/notes.txt",
        "cat /work/vera/notes.txt",
    ]) {
        expect(decideToolPermission(
            "approve_for_me",
            bash(command),
            workspace,
        )).toEqual({ behavior: "allow" });
    }
});

test("full access allows bash without asking", () => {
    for (const command of [
        "curl https://example.com",
        "cat /etc/hosts",
        "bun test",
    ]) {
        expect(decideToolPermission(
            "full_access",
            bash(command),
            workspace,
        )).toEqual({ behavior: "allow" });
    }
});

function modes(): readonly ApprovalMode[] {
    return ["ask", "approve_for_me", "full_access"];
}

function bash(command: string): HookToolCall {
    return toolCall("bash", { command });
}

function toolCall(name: string, input: JsonObject): HookToolCall {
    return { id: "call_1", name, input };
}
