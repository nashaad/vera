import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatScratchTodo, readScratchTodo } from "../../src/engine/scratch-state.ts";

test("a missing scratch dir, missing todo.md, or blank todo.md reads as absent", async () => {
    expect(await readScratchTodo("/nonexistent/scratch")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "vera-scratch-state-"));
    try {
        expect(await readScratchTodo(dir)).toBeUndefined();
        await writeFile(join(dir, "todo.md"), "  \n");
        expect(await readScratchTodo(dir)).toBeUndefined();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("todo.md is read whole, and a long one is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-scratch-state-"));
    try {
        await writeFile(join(dir, "todo.md"), "- [ ] bury the chest\n");
        expect(await readScratchTodo(dir)).toBe("- [ ] bury the chest\n");
        await writeFile(join(dir, "todo.md"), "x".repeat(3000));
        expect((await readScratchTodo(dir))?.endsWith("[truncated]")).toBe(true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the reminder names the file it came from", () => {
    const text = formatScratchTodo("/tmp/scratch", "- [ ] decoy lid\n");
    expect(text).toContain("/tmp/scratch/todo.md");
    expect(text).toContain("- [ ] decoy lid");
});
