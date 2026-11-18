import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { decideToolPermission } from "../../src/engine/permissions.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";
import { executeToolCall } from "../../src/tools/execute.ts";
import { resolveFileToolPermissionContext } from "../../src/tools/files.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("write creates a missing folder and names it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-folders-"));
    const runtime = new ToolRuntime(workspace);

    try {
        const result = await executeToolCall(toolCall(
            "call_write",
            "newdir/notes.txt",
            "hello\n",
        ), runtime);

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toBe(
            "Created folder newdir.\n"
                + "Wrote 1 line (6 bytes) to newdir/notes.txt (new file)",
        );
        expect(await Bun.file(join(workspace, "newdir", "notes.txt")).text())
            .toBe("hello\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("write creates every missing folder and names them", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-folders-"));
    const runtime = new ToolRuntime(workspace);

    try {
        const result = await executeToolCall(toolCall(
            "call_write",
            "one/two/notes.txt",
            "hello\n",
        ), runtime);

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toBe(
            "Created folders one, one/two.\n"
                + "Wrote 1 line (6 bytes) to one/two/notes.txt (new file)",
        );
        expect(await Bun.file(join(workspace, "one", "two", "notes.txt")).text())
            .toBe("hello\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a write refused by the permission check leaves no folder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-refused-"));

    try {
        const call = hookToolCall("newdir/notes.txt");
        const context = await resolveFileToolPermissionContext(workspace, call);
        const decision = decideToolPermission(
            "readonly",
            context.toolCall,
            context.workspace,
            [],
            { homeDirectory: dirname(workspace) },
        );

        expect(decision.behavior).toBe("deny");
        await expect(stat(join(workspace, "newdir")))
            .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a missing folder under a symlink that points outside is still caught", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-write-escape-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, "escape"));

    try {
        const context = await resolveFileToolPermissionContext(
            workspace,
            hookToolCall("escape/newdir/notes.txt"),
        );

        expect(context.toolCall.input.path).toBe(
            join(await realpath(outside), "newdir", "notes.txt"),
        );
        const options = { homeDirectory: dirname(root) };
        expect(decideToolPermission(
            "ask",
            context.toolCall,
            context.workspace,
            [],
            options,
        ).behavior).toBe("ask");
        expect(decideToolPermission(
            "readonly",
            context.toolCall,
            context.workspace,
            [],
            options,
        ).behavior).toBe("deny");
        await expect(stat(join(outside, "newdir")))
            .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an ancestor that is a file fails with a clear message", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-ancestor-"));
    const runtime = new ToolRuntime(workspace);
    await writeFile(join(workspace, "notes.txt"), "kept\n");

    try {
        const result = await executeToolCall(toolCall(
            "call_write",
            "notes.txt/nested/new.txt",
            "new\n",
        ), runtime);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
            "Cannot write notes.txt/nested/new.txt: notes.txt is a file, "
                + "not a folder",
        );
        expect(await Bun.file(join(workspace, "notes.txt")).text())
            .toBe("kept\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a dangling symlink at the target path is refused", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-dangling-"));
    const runtime = new ToolRuntime(workspace);
    await symlink(
        join(workspace, "absent", "target.txt"),
        join(workspace, "link.txt"),
    );

    try {
        const result = await executeToolCall(toolCall(
            "call_write",
            "link.txt",
            "new\n",
        ), runtime);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
            "Path is an unresolved symbolic link: link.txt",
        );
        await expect(stat(join(workspace, "absent")))
            .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

function toolCall(id: string, path: string, content: string) {
    return {
        type: "tool_call" as const,
        id,
        name: "write",
        input: { path, content },
    };
}

function hookToolCall(path: string): HookToolCall {
    return {
        id: "call_write",
        name: "write",
        input: { path, content: "new\n" },
    };
}
