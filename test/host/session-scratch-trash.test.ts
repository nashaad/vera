import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { sessionScratchDir } from "../../src/session-scratch.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("@core a host session starts with scratch in its own home, not TMPDIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-scratch-start-test-"));
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    const previousTmpdir = process.env.TMPDIR;
    await mkdir(temporary);
    process.env.TMPDIR = temporary;
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(home, "runtime", "sessions", `${id}.jsonl`),
    });
    try {
        await registry.create({ id: "saved", workspace: root });
        expect(existsSync(join(home, "runtime", "scratch", "saved"))).toBe(true);
        expect(existsSync(join(temporary, "vera"))).toBe(false);
    } finally {
        await registry.close();
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        await rm(root, { recursive: true, force: true });
    }
});

test("@core trashing a resident session removes its scratch and retains its neighbor", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-scratch-trash-test-"));
    let scratchInTrashBundle = true;
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(home, "runtime", "sessions", `${id}.jsonl`),
        trashSessionArtifacts: async (artifacts) => trashSessionArtifacts(artifacts, {
            moveToTrash: async ([bundle]) => {
                scratchInTrashBundle = existsSync(join(bundle!, "scratch"));
            },
        }),
    });
    try {
        const resident = await registry.create({ id: "saved", workspace: home });
        const scratch = sessionScratchDir(resident.id, home);
        const neighbor = sessionScratchDir("neighbor", home);
        await writeFile(join(scratch, "todo.md"), "save before removal");
        await writeFile(join(neighbor, "todo.md"), "other session");
        expect(await registry.trashSession("saved")).toBe("trashed");
        expect(scratchInTrashBundle).toBe(false);
        expect(existsSync(scratch)).toBe(false);
        expect(await readFile(join(neighbor, "todo.md"), "utf8")).toBe("other session");
    } finally {
        await registry.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core failed session trash leaves the scratch and session file intact", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-scratch-trash-fail-"));
    const registry = new AgentRegistry({
        home,
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(home, "runtime", "sessions", `${id}.jsonl`),
        trashSessionArtifacts: async (artifacts) => trashSessionArtifacts(artifacts, {
            moveToTrash: async () => { throw new Error("trash unavailable"); },
        }),
    });
    try {
        const resident = await registry.create({ id: "saved", workspace: home });
        const scratch = sessionScratchDir(resident.id, home);
        await writeFile(join(scratch, "todo.md"), "keep this");
        expect(await registry.trashSession("saved")).toBe("failed");
        expect(await readFile(join(scratch, "todo.md"), "utf8")).toBe("keep this");
        expect(existsSync(join(home, "runtime", "sessions", "saved.jsonl"))).toBe(true);
    } finally {
        await registry.close();
        await rm(home, { recursive: true, force: true });
    }
});
