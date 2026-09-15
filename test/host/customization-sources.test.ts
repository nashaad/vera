import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

test("source catalog is served without a turn and includes registered definitions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "source-wire-"));
    const home = await mkdtemp(join(tmpdir(), "source-home-"));
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    await mkdir(join(workspace, ".vera/agents"), { recursive: true });
    await writeFile(join(workspace, ".vera/agents/reader.md"), "---\ndescription: Read notes\nposture: readonly\n---\nRead the notes.\n");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]), model: "test", approvalMode: "ask",
        registeredAgents: [{ name: "explorer", description: "Investigate", instructions: "Look around" }],
    });
    try {
        const session = await registry.create({ id: "source-trial", workspace, sessionPath: join(workspace, "session.jsonl") });
        const client = session.attach();
        await client.receive();
        client.send({ type: "list_customization_sources", requestId: "sources" });
        const update = await Promise.race([
            (async () => { while (true) { const next = await client.receive(); if (next.type === "customization_sources") return next; } })(),
            Bun.sleep(3000).then(() => { throw new Error("Catalog timed out"); }),
        ]);
        expect(update.requestId).toBe("sources");
        expect(update.catalog.sources.find((source) => source.name === "reader")?.content).toContain("Read the notes");
        expect(update.catalog.sources.find((source) => source.name === "explorer")?.editable).toBe(false);
        expect(parseAgentUpdate(update)?.type).toBe("customization_sources");
    } finally {
        await registry.close();
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
    }
});
