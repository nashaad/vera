import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectMemoryDir } from "../../src/engine/memory-paths.ts";
import { runSubagent } from "../../src/engine/subagent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

// `homedir()` is resolved once per process, so the only way to point the memory
// root at a scratch directory is to set HOME before the process starts.
const ISOLATED = "VERA_SUBAGENT_MEMORY_TEST_HOME";

if (process.env[ISOLATED] === undefined) {
    test("a child's memory write lands under an isolated HOME", async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-subagent-home-"));
        try {
            const child = Bun.spawn(["bun", "test", import.meta.path], {
                env: { ...process.env, HOME: home, [ISOLATED]: home },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [code, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);
            expect(stderr.length > 0 ? stderr : "no output").toContain("0 fail");
            expect(code).toBe(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }, 60_000);
} else {
    registerTests();
}

function registerTests(): void {
    test("a subagent writes project memory under the parent's instruction root", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "vera-child-cwd-"));
        const parentRoot = await mkdtemp(join(tmpdir(), "vera-parent-root-"));
        const responses: AssistantMessage[] = [
            {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "write-1",
                    name: "memory_write",
                    input: {
                        scope: "project",
                        file: "layout.md",
                        content: "Engine never imports UI.",
                        title: "Layout",
                        hook: "where each layer lives",
                    },
                }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "Recorded." }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        ];

        try {
            const result = await runSubagent({
                adapter: new FauxAdapter(responses),
                model: "test",
                description: "Record the layout rule",
                workspace,
                instructionRoot: { path: parentRoot, source: "git" },
                // No approval relay is wired, so an unapproved call is denied
                // and the file never lands.
                approvalMode: "ask",
                sessionId: "child-1",
                sessionPath: join(workspace, "child-1.jsonl"),
            });

            expect(result.isError).toBe(false);
            const written = join(
                projectMemoryDir(parentRoot),
                "layout.md",
            );
            expect(await Bun.file(written).text())
                .toBe("Engine never imports UI.\n");
            expect(
                await Bun.file(
                    join(projectMemoryDir(workspace), "layout.md"),
                ).exists(),
            ).toBe(false);
        } finally {
            await rm(workspace, { recursive: true, force: true });
            await rm(parentRoot, { recursive: true, force: true });
        }
    }, 30_000);
}
