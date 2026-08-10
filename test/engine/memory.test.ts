import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadMemory,
    memoryMetadata,
    type InstructionRoot,
    type MemoryDirectories,
} from "../../src/engine/memory.ts";
import { MEMORY_INDEX_FILENAME } from "../../src/engine/memory-paths.ts";
import { assembleContextualSystemPrompt } from "../../src/engine/assemble.ts";
import { collectContextualPromptContributions } from "../../src/engine/prompt-contributions.ts";

const scratch: string[] = [];

afterEach(async () => {
    await Promise.all(
        scratch.splice(0).map((path) =>
            rm(path, { recursive: true, force: true })
        ),
    );
});

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vera-memory-"));
    scratch.push(dir);
    return dir;
}

/** Kept off the real home directory, which holds the user's own memory. */
async function tempDirectories(): Promise<MemoryDirectories> {
    const root = await tempDir();
    return { user: join(root, "user"), project: join(root, "project") };
}

async function writeIndex(dir: string, content: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MEMORY_INDEX_FILENAME), content);
}

function gitRoot(path: string): InstructionRoot {
    return { path, source: "git" };
}

const DATE = new Date("2026-08-08T00:00:00Z");

test("no memory directories load nothing and warn about nothing", async () => {
    const snapshot = await loadMemory(
        gitRoot(await tempDir()),
        await tempDirectories(),
    );

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    expect(memoryMetadata(snapshot)).toEqual({ files: [], warnings: [] });
});

test("both scopes load, user first, and each renders its own directory", async () => {
    const dirs = await tempDirectories();
    await writeIndex(
        dirs.user,
        "- [Style](style.md): how the user likes prose\n",
    );
    await writeIndex(
        dirs.project,
        "- [Layers](layers.md): engine never imports UI\n",
    );

    const snapshot = await loadMemory(gitRoot(await tempDir()), dirs);

    expect(snapshot.files.map((file) => file.scope)).toEqual([
        "user",
        "project",
    ]);
    expect(snapshot.warnings).toEqual([]);

    const prompt = assembleContextualSystemPrompt({
        date: DATE,
        memory: snapshot,
    });
    expect(prompt).toContain(
        "Memory index. Each line points to a file under "
            + `\`${dirs.user}\`; read a file when its hook is relevant `
            + "to the task.",
    );
    expect(prompt).toContain(
        "Memory index. Each line points to a file under "
            + `\`${dirs.project}\`; read a file when its hook is relevant `
            + "to the task.",
    );
    expect(prompt).toContain("- [Style](style.md): how the user likes prose");
    expect(prompt).toContain("- [Layers](layers.md): engine never imports UI");
});

test("the memory contribution is contextual and absent without memory", async () => {
    const dirs = await tempDirectories();
    await writeIndex(dirs.project, "- [One](one.md): a hook\n");

    const contributions = collectContextualPromptContributions({
        date: DATE,
        memory: await loadMemory(gitRoot(await tempDir()), dirs),
    });
    const memory = contributions.find((entry) => entry.id === "core.memory");
    expect(memory?.target).toBe("contextual");

    const empty = collectContextualPromptContributions({
        date: DATE,
        memory: await loadMemory(
            gitRoot(await tempDir()),
            await tempDirectories(),
        ),
    });
    expect(empty.some((entry) => entry.id === "core.memory")).toBe(false);
});

test("an index past the hard limit is refused with a warning", async () => {
    const dirs = await tempDirectories();
    await writeIndex(dirs.project, "x".repeat(8 * 1024 + 1));

    const snapshot = await loadMemory(gitRoot(await tempDir()), dirs);

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual([
        "the project memory index is 8193 bytes; "
            + "the 8192-byte limit was exceeded",
    ]);
});

test("an index past the warn threshold still loads", async () => {
    const dirs = await tempDirectories();
    await writeIndex(dirs.project, "x".repeat(4 * 1024 + 1));

    const snapshot = await loadMemory(gitRoot(await tempDir()), dirs);

    expect(snapshot.files.map((file) => file.bytes)).toEqual([4097]);
    expect(snapshot.warnings).toEqual([
        "the project memory index is 4097 bytes; it is refused past 8192 "
            + "bytes, so move detail into topic files",
        "project memory index line 1 is invalid and was omitted",
    ]);
});

test("a workspace that is not a repository says so beside its memory", async () => {
    const dirs = await tempDirectories();
    const root = await tempDir();
    await mkdir(dirs.project, { recursive: true });
    await writeIndex(dirs.project, "- [One](one.md): a hook\n");

    const snapshot = await loadMemory({ path: root, source: "workspace" }, dirs);

    expect(snapshot.files.map((file) => file.scope)).toEqual(["project"]);
    expect(snapshot.warnings).toEqual([
        `project memory is keyed on ${root}, which is not a git repository`,
    ]);
});

test("a workspace that is not a repository stays silent with no memory", async () => {
    const snapshot = await loadMemory(
        { path: await tempDir(), source: "workspace" },
        await tempDirectories(),
    );

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
});

test("an instruction root that no longer exists is reported", async () => {
    const dirs = await tempDirectories();
    await mkdir(dirs.project, { recursive: true });
    const root = join(await tempDir(), "deleted-checkout");
    await writeIndex(dirs.project, "- [One](one.md): a hook\n");

    const snapshot = await loadMemory(gitRoot(root), dirs);

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual([
        `the instruction root ${root} does not exist, `
            + "so no project memory was loaded",
    ]);
});

test("discovery parses topics and loads an exact hook match", async () => {
    const dirs = await tempDirectories();
    await mkdir(dirs.project, { recursive: true });
    const root = await tempDir();
    await writeFile(join(dirs.project, "tests.md"), "Run bun test.");
    await writeIndex(
        dirs.project,
        "- [Tests](tests.md): how to run tests\n",
    );

    const snapshot = await loadMemory(
        gitRoot(root),
        dirs,
        { query: "Please tell me how to run tests" },
    );

    expect(snapshot.files[0]?.topics).toEqual([{
        scope: "project",
        file: "tests.md",
        path: join(dirs.project, "tests.md"),
        title: "Tests",
        hook: "how to run tests",
        availability: "available",
        bytes: 13,
    }]);
    expect(snapshot.recommendations.map((topic) => topic.file)).toEqual([
        "tests.md",
    ]);
    expect(snapshot.loadedTopics.map((topic) => topic.content)).toEqual([
        "Run bun test.",
    ]);
    expect(memoryMetadata(snapshot).loadedTopics?.[0]?.file).toBe("tests.md");
});

test("hook matching has an explicit no-match result", async () => {
    const dirs = await tempDirectories();
    await mkdir(dirs.project, { recursive: true });
    await writeFile(join(dirs.project, "style.md"), "Use prose.");
    await writeIndex(dirs.project, "- [Style](style.md): prose style\n");

    const snapshot = await loadMemory(
        gitRoot(await tempDir()),
        dirs,
        { query: "what is the deployment hostname" },
    );

    expect(snapshot.recommendations).toEqual([]);
    expect(snapshot.loadedTopics).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
});

test("multiple matches are path ordered and stop at the topic bound", async () => {
    const dirs = await tempDirectories();
    await mkdir(dirs.project, { recursive: true });
    const lines: string[] = [];
    for (let index = 9; index >= 0; index--) {
        const file = `topic-${index}.md`;
        await writeFile(join(dirs.project, file), `body ${index}`);
        lines.push(`- [Topic ${index}](${file}): alpha topic`);
    }
    await writeIndex(dirs.project, lines.join("\n"));

    const snapshot = await loadMemory(
        gitRoot(await tempDir()),
        dirs,
        { query: "alpha topic" },
    );

    expect(snapshot.recommendations.map((topic) => topic.file)).toEqual(
        Array.from({ length: 10 }, (_, index) => `topic-${index}.md`),
    );
    expect(snapshot.loadedTopics.map((topic) => topic.file)).toEqual(
        Array.from({ length: 8 }, (_, index) => `topic-${index}.md`),
    );
    expect(snapshot.warnings).toContain(
        "memory topic bound reached at 8; 2 matching topic(s) were not read",
    );
});

test("matching keeps user and project scopes isolated and user topics first", async () => {
    const dirs = await tempDirectories();
    const root = await tempDir();
    await mkdir(dirs.user, { recursive: true });
    await mkdir(dirs.project, { recursive: true });
    await writeFile(join(dirs.user, "user.md"), "User preference.");
    await writeFile(join(dirs.project, "project.md"), "Project rule.");
    await writeIndex(dirs.user, "- [User](user.md): shared topic\n");
    await writeIndex(dirs.project, "- [Project](project.md): shared topic\n");

    const snapshot = await loadMemory(
        gitRoot(root),
        dirs,
        { query: "shared topic" },
    );

    expect(snapshot.recommendations.map((topic) => `${topic.scope}/${topic.file}`))
        .toEqual(["user/user.md", "project/project.md"]);
    expect(snapshot.loadedTopics.map((topic) => topic.scope)).toEqual([
        "user",
        "project",
    ]);
});

test("invalid, missing, stale, unreadable, invalid-UTF8, and oversized topics are explicit", async () => {
    const dirs = await tempDirectories();
    const root = await tempDir();
    await mkdir(dirs.project, { recursive: true });
    await mkdir(join(dirs.project, "unreadable.md"));
    await writeFile(join(dirs.project, "stale.md"), "old");
    await writeFile(join(dirs.project, "bad.md"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(dirs.project, "large.md"), "x".repeat(32 * 1024 + 1));
    await writeIndex(dirs.project, [
        "- [Missing](missing.md): memory topic",
        "- [Escape](../escape.md): memory topic",
        "- [Unreadable](unreadable.md): memory topic",
        "- [Stale](stale.md): memory topic",
        "- [Bad](bad.md): memory topic",
        "- [Large](large.md): memory topic",
    ].join("\n"));
    const future = new Date(Date.now() + 60_000);
    await utimes(join(dirs.project, "stale.md"), future, future);

    const snapshot = await loadMemory(gitRoot(root), dirs, { query: "memory topic" });
    const byFile = new Map(snapshot.files[0]?.topics.map((topic) => [topic.file, topic]));
    expect(byFile.get("missing.md")?.availability).toBe("missing");
    expect(byFile.get("../escape.md")?.availability).toBe("invalid");
    expect(byFile.get("unreadable.md")?.availability).toBe("unreadable");
    expect(byFile.get("stale.md")?.availability).toBe("stale");
    expect(byFile.get("large.md")?.availability).toBe("oversized");
    expect(snapshot.loadedTopics).toEqual([]);
    expect(snapshot.warnings.some((warning) => warning.includes("invalid-UTF8"))).toBe(false);
    expect(snapshot.warnings.some((warning) => warning.includes("bad.md") && warning.includes("invalid"))).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.includes("missing.md") && warning.includes("missing"))).toBe(true);
});
