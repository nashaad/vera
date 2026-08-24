import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTool, READ_MAX_LINES, resolveReadPath } from "../../src/tools/files.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

async function workspace(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "vera-read-"));
}

function read(input: Record<string, unknown>, cwd: string) {
    return readTool.execute(input, new ToolRuntime(cwd), new AbortController().signal);
}

test("read returns a line range and says how to continue", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");

        const result = await read({ path: "a.txt", offset: 2, limit: 2 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain("2\ttwo");
            expect(result.output).toContain("3\tthree");
            expect(result.output).not.toContain("1\tone");
            expect(result.output).toContain("Showing lines 2-3 of 5");
            expect(result.output).toContain("Use offset=4 to continue");
            expect(result.output).toContain("whole-file read first");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a read to the end of the file closes the page", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "hello\n");

        const result = await read({ path: "a.txt" }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain("1\thello");
            expect(result.output).toContain("Showing lines 1-1 of 1");
            expect(result.output).not.toContain("continue");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an offset past the end of the file is refused with the line count", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "hello");

        const result = await read({ path: "a.txt", offset: 99 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(true);
            expect(result.output).toContain("99");
            expect(result.output).toContain("1 line");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("binary content is refused with its size and a way forward", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

        const result = await read({ path: "a.bin" }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(true);
            expect(result.output).toContain("not UTF-8 text");
            expect(result.output).toContain("5 bytes");
            expect(result.output).toContain("bash");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a range read that stops short does not satisfy edit's read requirement", async () => {
    const cwd = await workspace();
    const runtime = new ToolRuntime(cwd);
    try {
        await writeFile(join(cwd, "a.txt"), "a\nb\nc\nd\ne\n");

        await readTool.execute(
            { path: "a.txt", offset: 1, limit: 4 },
            runtime,
            new AbortController().signal,
        );

        expect(() => {
            runtime.assertFreshFileSnapshot(join(cwd, "a.txt"), "a\nb\nc\nd\ne\n", "a.txt");
        }).toThrow("Read a.txt before editing it");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a read is capped at the line limit and names the continuation offset", async () => {
    const cwd = await workspace();
    try {
        const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
        await writeFile(join(cwd, "a.txt"), lines.join("\n") + "\n");

        const result = await read({ path: "a.txt" }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain(`1\tline 1`);
            expect(result.output).toContain(`${READ_MAX_LINES}\tline ${READ_MAX_LINES}`);
            expect(result.output).not.toContain(`${READ_MAX_LINES + 1}\t`);
            expect(result.output).toContain(
                `Showing lines 1-${READ_MAX_LINES} of 2500`,
            );
            expect(result.output).toContain(
                `Use offset=${READ_MAX_LINES + 1} to continue`,
            );
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an explicit limit beyond the cap is clamped", async () => {
    const cwd = await workspace();
    try {
        const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
        await writeFile(join(cwd, "a.txt"), lines.join("\n") + "\n");

        const result = await read({ path: "a.txt", limit: 5000 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain(
                `Showing lines 1-${READ_MAX_LINES} of 2500`,
            );
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("line numbering starts from the requested offset", async () => {
    const cwd = await workspace();
    try {
        const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
        await writeFile(join(cwd, "a.txt"), lines.join("\n") + "\n");

        const result = await read({ path: "a.txt", offset: 1001, limit: 2 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain("1001\tline 1001");
            expect(result.output).toContain("1002\tline 1002");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("paging to the end records the snapshot edit needs", async () => {
    const cwd = await workspace();
    const runtime = new ToolRuntime(cwd);
    try {
        const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
        const content = lines.join("\n") + "\n";
        await writeFile(join(cwd, "a.txt"), content);

        const result = await readTool.execute(
            { path: "a.txt", offset: 2001 },
            runtime,
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain("Showing lines 2001-2500 of 2500");
            expect(result.output).not.toContain("continue");
        }
        const resolved = await resolveReadPath(cwd, "a.txt");
        expect(() => {
            runtime.assertFreshFileSnapshot(
                resolved,
                content,
                "a.txt",
            );
        }).not.toThrow();
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an empty file reads as empty and is a whole-file snapshot", async () => {
    const cwd = await workspace();
    const runtime = new ToolRuntime(cwd);
    try {
        await writeFile(join(cwd, "a.txt"), "");

        const result = await readTool.execute(
            { path: "a.txt" },
            runtime,
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toBe("");
        }
        const resolved = await resolveReadPath(cwd, "a.txt");
        expect(() => {
            runtime.assertFreshFileSnapshot(resolved, "", "a.txt");
        }).not.toThrow();
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("offset and limit are 1-indexed and refuse 0", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "one\ntwo\n");

        await expect(read({ path: "a.txt", offset: 0 }, cwd))
            .rejects.toThrow("at least 1");
        await expect(read({ path: "a.txt", limit: 0 }, cwd))
            .rejects.toThrow("at least 1");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a subagent is refused a disable-model-invocation skill's SKILL.md, a top-level session is not", async () => {
    const cwd = await workspace();
    try {
        const skillDir = join(cwd, ".vera", "skills", "adversarial");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), `---
name: adversarial
description: Read-only adversarial review.
disable-model-invocation: true
---
Body.
`);
        const skillPath = join(".vera", "skills", "adversarial", "SKILL.md");

        const subagentRuntime = new ToolRuntime(
            cwd,
            undefined,
            undefined,
            undefined,
            cwd,
            undefined,
            true,
        );
        const refused = await readTool.execute(
            { path: skillPath },
            subagentRuntime,
            new AbortController().signal,
        );
        expect(refused.kind).toBe("output");
        if (refused.kind === "output") {
            expect(refused.isError).toBe(true);
            expect(refused.output).toContain("disable-model-invocation");
        }

        const topLevelRuntime = new ToolRuntime(
            cwd,
            undefined,
            undefined,
            undefined,
            cwd,
        );
        const allowed = await readTool.execute(
            { path: skillPath },
            topLevelRuntime,
            new AbortController().signal,
        );
        expect(allowed.kind).toBe("output");
        if (allowed.kind === "output") {
            expect(allowed.isError).toBe(false);
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
