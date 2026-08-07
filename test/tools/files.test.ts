import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTool } from "../../src/tools/files.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

async function workspace(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "vera-read-"));
}

function read(input: Record<string, unknown>, cwd: string) {
    return readTool.execute(input, new ToolRuntime(cwd), new AbortController().signal);
}

test("read returns a byte range and says how to continue", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "0123456789");

        const result = await read({ path: "a.txt", offset: 2, limit: 3 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output).toContain("234");
            expect(result.output).toContain("Showed bytes 2-5");
            expect(result.output).toContain("offset=5");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a whole-file read carries no range marker", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "hello\n");

        const result = await read({ path: "a.txt" }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toBe("hello\n");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an offset past the end of the file is refused with the size", async () => {
    const cwd = await workspace();
    try {
        await writeFile(join(cwd, "a.txt"), "hello");

        const result = await read({ path: "a.txt", offset: 99 }, cwd);

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(true);
            expect(result.output).toContain("5");
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
            expect(result.output).toContain("offset");
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a range read does not satisfy edit's whole-file read requirement", async () => {
    const cwd = await workspace();
    const runtime = new ToolRuntime(cwd);
    try {
        await writeFile(join(cwd, "a.txt"), "0123456789");

        await readTool.execute(
            { path: "a.txt", offset: 0, limit: 4 },
            runtime,
            new AbortController().signal,
        );

        expect(() => {
            runtime.assertFreshFileSnapshot(join(cwd, "a.txt"), "0123456789", "a.txt");
        }).toThrow("Read a.txt before editing it");
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
