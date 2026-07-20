import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadProjectInstructions,
    projectInstructionMetadata,
} from "../../src/engine/project-instructions.ts";
import { assembleSystemPrompt } from "../../src/engine/assemble.ts";

test("project instructions load in public then private order with hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await writeFile(join(root, "AGENTS.md"), "public guidance\n");
        await writeFile(join(root, "AGENTS.local.md"), "private guidance\n");

        const snapshot = await loadProjectInstructions(root);
        expect(snapshot.files.map((file) => file.name)).toEqual([
            "AGENTS.md",
            "AGENTS.local.md",
        ]);
        expect(snapshot.files.map((file) => file.content)).toEqual([
            "public guidance\n",
            "private guidance\n",
        ]);
        expect(snapshot.warnings).toEqual([]);
        expect(projectInstructionMetadata(snapshot)).toEqual({
            files: snapshot.files.map(({ name, bytes, sha256 }) => ({
                name,
                bytes,
                sha256,
            })),
            warnings: [],
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("missing project instructions are ordinary absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        const snapshot = await loadProjectInstructions(root);
        expect(snapshot.files).toEqual([]);
        expect(snapshot.warnings).toEqual([]);
        expect(assembleSystemPrompt({
            tools: [],
            workspace: root,
            date: new Date("2026-07-20T00:00:00.000Z"),
            projectInstructions: snapshot,
        })).not.toContain("Project instructions");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("project instruction content is visible at the contextual prompt edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await writeFile(join(root, "AGENTS.md"), "Use the repository tests.\n");
        const snapshot = await loadProjectInstructions(root);
        const prompt = assembleSystemPrompt({
            tools: [],
            workspace: root,
            date: new Date("2026-07-20T00:00:00.000Z"),
            projectInstructions: snapshot,
        });
        expect(prompt).toContain("## Project instructions");
        expect(prompt).toContain("### AGENTS.md\nUse the repository tests.");
        expect(prompt.indexOf("## Identity")).toBeLessThan(
            prompt.indexOf("## Project instructions"),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("oversized and invalid-UTF8 instructions produce diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await writeFile(join(root, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
        await writeFile(join(root, "AGENTS.local.md"), Buffer.from([0xff, 0xfe]));
        const snapshot = await loadProjectInstructions(root);
        expect(snapshot.files).toEqual([]);
        expect(snapshot.warnings).toEqual([
            expect.stringContaining("AGENTS.md"),
            expect.stringContaining("AGENTS.local.md"),
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("instruction discovery does not crawl nested files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "nested", "AGENTS.md"), "nested guidance");
        const snapshot = await loadProjectInstructions(root);
        expect(snapshot.files).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
