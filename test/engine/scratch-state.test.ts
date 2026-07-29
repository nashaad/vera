import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadScratchState } from "../../src/engine/scratch-state.ts";

test("a missing or empty scratch dir reads as absent", async () => {
    expect(await loadScratchState("/nonexistent/scratch")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "vera-scratch-state-"));
    try {
        expect(await loadScratchState(dir)).toBeUndefined();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("scratch state lists files and inlines todo.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-scratch-state-"));
    try {
        await writeFile(join(dir, "notes.txt"), "hi");
        await writeFile(join(dir, "todo.md"), "- [ ] step one\n");
        const state = await loadScratchState(dir);
        expect(state?.files).toEqual(["notes.txt", "todo.md"]);
        expect(state?.truncatedFiles).toBe(0);
        expect(state?.todo).toBe("- [ ] step one\n");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("long listings and todos are truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-scratch-state-"));
    try {
        for (let index = 0; index < 25; index += 1) {
            await writeFile(join(dir, `file-${String(index).padStart(2, "0")}`), "x");
        }
        await writeFile(join(dir, "todo.md"), "x".repeat(3000));
        const state = await loadScratchState(dir);
        expect(state?.files).toHaveLength(20);
        expect(state?.truncatedFiles).toBe(6);
        expect(state?.todo?.endsWith("[truncated]")).toBe(true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
