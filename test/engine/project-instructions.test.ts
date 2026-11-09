import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lexer } from "marked";

import {
    loadProjectInstructions,
    projectInstructionMetadata,
} from "../../src/engine/project-instructions.ts";
import { assembleSystemPrompt } from "../../src/engine/assemble.ts";

test("cached imports match a cold parse and follow file and symlink changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-cache-"));
    const lexer = spyOn(Lexer.prototype, "lex");
    const time = new Date("2020-01-01T00:00:00.000Z");
    try {
        const instruction = join(root, "AGENTS.md");
        const body = Array.from({ length: 2_000 }, (_, index) => `reef${index}`).join(" ");
        await writeFile(instruction, `${body}\n\n@one.md\n`);
        await writeFile(join(root, "one.md"), "first chart\n");
        await writeFile(join(root, "two.md"), "other chart\n");
        await utimes(instruction, time, time);
        await utimes(join(root, "two.md"), time, time);

        const cold = await loadProjectInstructions(root);
        const realRoot = await realpath(root);
        const expectedFile = (name: string, content: string) => ({
            name,
            path: join(realRoot, name),
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sha256: createHash("sha256").update(content).digest("hex"),
        });
        expect(cold).toEqual({
            files: [
                expectedFile("AGENTS.md", `${body}\n\n@one.md\n`),
                expectedFile("one.md", "first chart\n"),
            ],
            warnings: [],
        });
        const coldCalls = lexer.mock.calls.length;
        expect(coldCalls).toBe(2);
        expect(await loadProjectInstructions(root)).toEqual(cold);
        expect(lexer.mock.calls.length).toBe(coldCalls);

        const previous = await stat(instruction);
        await writeFile(instruction, `${body}\n\n@two.md\n`);
        await utimes(instruction, time, time);
        const changed = await stat(instruction);
        expect([changed.size, changed.mtimeMs]).toEqual([previous.size, previous.mtimeMs]);
        const switched = await loadProjectInstructions(root);
        expect(switched).toEqual({
            files: [
                expectedFile("AGENTS.md", `${body}\n\n@two.md\n`),
                expectedFile("two.md", "other chart\n"),
            ],
            warnings: [],
        });
        expect(switched.files.map((file) => file.name)).toEqual(["AGENTS.md", "two.md"]);
        expect(switched.files[1]?.content).toBe("other chart\n");
        expect(lexer.mock.calls.length).toBe(coldCalls + 2);
        expect(await loadProjectInstructions(root)).toEqual(switched);

        const imported = join(root, "two.md");
        const importedBefore = await stat(imported);
        await writeFile(imported, "later chart\n");
        await utimes(imported, time, time);
        const importedAfter = await stat(imported);
        expect([importedAfter.size, importedAfter.mtimeMs])
            .toEqual([importedBefore.size, importedBefore.mtimeMs]);
        const changedImport = await loadProjectInstructions(root);
        expect(changedImport.files[1]?.content).toBe("later chart\n");
        expect(lexer.mock.calls.length).toBe(coldCalls + 3);
        expect(await loadProjectInstructions(root)).toEqual(changedImport);

        await unlink(imported);
        const missing = await loadProjectInstructions(root);
        expect(missing.files.map((file) => file.name)).toEqual(["AGENTS.md"]);
        expect(missing.warnings).toHaveLength(1);
        await writeFile(imported, "later chart\n");
        await utimes(imported, time, time);
        expect(await loadProjectInstructions(root)).toEqual(changedImport);

        await unlink(imported);
        await writeFile(join(root, "target.md"), "linked chart\n");
        await symlink("target.md", imported);
        const linked = await loadProjectInstructions(root);
        expect(linked.files.map((file) => file.name)).toEqual(["AGENTS.md", "target.md"]);
        expect(linked.files[1]?.content).toBe("linked chart\n");
        expect(await loadProjectInstructions(root)).toEqual(linked);

        const callsBeforeMtime = lexer.mock.calls.length;
        const later = new Date("2020-01-02T00:00:00.000Z");
        await utimes(instruction, later, later);
        expect(await loadProjectInstructions(root)).toEqual(linked);
        expect(lexer.mock.calls.length).toBe(callsBeforeMtime + 1);
        await appendFile(instruction, "\nAnother chart.\n");
        const appended = await loadProjectInstructions(root);
        expect(appended.files[0]?.content).toEndWith("Another chart.\n");
        expect(appended.files[1]?.content).toBe("linked chart\n");
        expect(await loadProjectInstructions(root)).toEqual(appended);
    } finally {
        lexer.mockRestore();
        await rm(root, { recursive: true, force: true });
    }
});

test("evicted import entries reparse to the same snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-cache-"));
    const lexer = spyOn(Lexer.prototype, "lex");
    try {
        const names = Array.from({ length: 68 }, (_, index) => `map-${index}.md`);
        await writeFile(join(root, "AGENTS.md"), names.map((name) => `@${name}`).join("\n"));
        for (const name of names) await writeFile(join(root, name), `Chart ${name}\n`);
        const cold = await loadProjectInstructions(root);
        const calls = lexer.mock.calls.length;
        expect(cold.files).toHaveLength(69);
        expect(await loadProjectInstructions(root)).toEqual(cold);
        expect(lexer.mock.calls.length).toBeGreaterThan(calls);
    } finally {
        lexer.mockRestore();
        await rm(root, { recursive: true, force: true });
    }
});

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

test("project instructions import referenced files in encounter order", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await mkdir(join(root, "rules"));
        await writeFile(
            join(root, "AGENTS.md"),
            "public guidance\n\n@rules/testing\\ guide.md#focused-tests\n",
        );
        await writeFile(
            join(root, "rules", "testing guide.md"),
            "Run the focused tests.\n",
        );
        await writeFile(join(root, "AGENTS.local.md"), "private guidance\n");

        const snapshot = await loadProjectInstructions(root);

        expect(snapshot.files.map((file) => file.name)).toEqual([
            "AGENTS.md",
            "rules/testing guide.md",
            "AGENTS.local.md",
        ]);
        expect(snapshot.files[1]?.content).toBe("Run the focused tests.\n");
        expect(snapshot.warnings).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("project instruction imports recurse once per resolved file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await mkdir(join(root, "rules"));
        await writeFile(
            join(root, "AGENTS.md"),
            "@rules/one.md\n@rules/two.md\n",
        );
        await writeFile(
            join(root, "rules", "one.md"),
            "@two.md\nfirst\n",
        );
        await writeFile(
            join(root, "rules", "two.md"),
            "@one.md\nsecond\n",
        );

        const snapshot = await loadProjectInstructions(root);

        expect(snapshot.files.map((file) => file.name)).toEqual([
            "AGENTS.md",
            "rules/one.md",
            "rules/two.md",
        ]);
        expect(snapshot.warnings).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("project instruction imports ignore code and comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await writeFile(
            join(root, "AGENTS.md"),
            [
                "`@inline.md`",
                "```md",
                "@fenced.md",
                "```",
                "<!-- @comment.md -->",
                "@loaded.md",
                "",
            ].join("\n"),
        );
        await writeFile(join(root, "inline.md"), "inline\n");
        await writeFile(join(root, "fenced.md"), "fenced\n");
        await writeFile(join(root, "comment.md"), "comment\n");
        await writeFile(join(root, "loaded.md"), "loaded\n");

        const snapshot = await loadProjectInstructions(root);

        expect(snapshot.files.map((file) => file.name)).toEqual([
            "AGENTS.md",
            "loaded.md",
        ]);
        expect(snapshot.warnings).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("project instruction imports do not escape the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    const root = join(parent, "workspace");
    try {
        await mkdir(root);
        await writeFile(join(parent, "outside.md"), "outside\n");
        await writeFile(join(root, "AGENTS.md"), "@../outside.md\n");

        const snapshot = await loadProjectInstructions(root);

        expect(snapshot.files.map((file) => file.name)).toEqual(["AGENTS.md"]);
        expect(snapshot.warnings).toEqual([
            expect.stringContaining("outside the workspace"),
        ]);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("project instruction imports stop after four hops", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-project-instructions-"));
    try {
        await writeFile(join(root, "AGENTS.md"), "@one.md\n");
        await writeFile(join(root, "one.md"), "@two.md\n");
        await writeFile(join(root, "two.md"), "@three.md\n");
        await writeFile(join(root, "three.md"), "@four.md\n");
        await writeFile(join(root, "four.md"), "@five.md\n");
        await writeFile(join(root, "five.md"), "too deep\n");

        const snapshot = await loadProjectInstructions(root);

        expect(snapshot.files.map((file) => file.name)).toEqual([
            "AGENTS.md",
            "one.md",
            "two.md",
            "three.md",
            "four.md",
        ]);
        expect(snapshot.warnings).toEqual([
            expect.stringContaining("skipped after 4 hops"),
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
