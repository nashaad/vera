import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { ModelMessage, ModelTool } from "../../src/model/types.ts";
import explorerAdapter from "./fixtures/worker-explorer-adapter.ts";

interface RecordedRequest {
    readonly pid: number;
    readonly model: string;
    readonly effort?: string;
    readonly system: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
}

for (const worker of [false, true]) {
    test(`explorer discovery and execution work with worker=${worker}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-explorer-run-"));
        const requestsPath = join(root, "requests.jsonl");
        const source = "Appointment update\nThe appointment moved to Friday.\nRaw appendix that should stay out of the parent.\n";
        await writeFile(join(root, "record.txt"), source);
        const extensions = await startExtensionRegistry({
            extensions: includedExtensionConfigs([]),
        });
        const registry = new AgentRegistry({
            createAdapter: () => explorerAdapter({ requestsPath }),
            ...(worker ? {
                workerAdapterSpec: () => ({
                    module: fileURLToPath(new URL("./fixtures/worker-explorer-adapter.ts", import.meta.url)),
                    options: { requestsPath },
                }),
            } : {}),
            provider: "faux", model: "parent", approvalMode: "auto",
            registeredAgents: extensions.agents(),
            readPool: () => ["small", "ordinary"].map((model) => ({
                provider: "faux", model, label: model,
                available: true, verified: true,
                levels: [{ id: "low", label: "Low" }],
            })),
            readPolicy: () => ({
                assigned: [{ provider: "faux", model: "ordinary" }],
                assignments: { eco: [{ provider: "faux", model: "small", reasoningEffort: "low" }] },
            }),
        });
        let pids: number[] = [];
        try {
            const parent = await registry.create({
                id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl"),
            });
            const attachment = parent.attach();
            attachment.send({ type: "prompt", content: "Private parent context. Investigate the appointment date." });
            const signal = AbortSignal.timeout(15_000);
            for (;;) {
                const update = await attachment.receive(signal);
                if (update.type === "agent_failed") throw new Error(update.detail);
                if (update.type === "turn_finished") break;
            }
            const requests: RecordedRequest[] = (await readFile(requestsPath, "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line));
            pids = [...new Set(requests.map((request) => request.pid))];
            expect(requests.map((request) => request.model))
                .toEqual(["parent", "small", "small", "parent"]);
            const parentRequest = requests[0]!;
            const catalog = JSON.stringify(parentRequest.tools.find((tool) => tool.name === "subagent"));
            expect(catalog).toContain("explorer: Read-only investigation");
            expect(catalog).not.toContain("Investigate the assigned question without changing");
            expect(catalog).not.toContain("Defaults to this agent's model.");
            const child = requests[1]!;
            expect(child.effort).toBe("low");
            expect(child.tools.map((tool) => tool.name).sort()).toEqual(["grep", "list", "read"]);
            expect(child.system).toContain("Distinguish evidence from inference.");
            expect(JSON.stringify(child.messages)).not.toContain("Private parent context");
            expect(JSON.stringify(requests[2]!.messages)).toContain("The appointment moved to Friday.");
            const returned = JSON.stringify(requests[3]!.messages);
            expect(returned).toContain("The appointment moved to Friday (record.txt:2).");
            expect(returned).toContain("Agent: explorer\\nModel: faux/small\\nReasoning effort: low");
            expect(returned).not.toContain("Raw appendix");
            expect(await readFile(join(root, "record.txt"), "utf8")).toBe(source);
            expect(pids).toHaveLength(1);
            if (worker) expect(pids[0]).not.toBe(process.pid);
            else expect(pids[0]).toBe(process.pid);
        } finally {
            await registry.close();
            await extensions.close();
            for (const pid of pids.filter((value) => value !== process.pid)) {
                expect(() => process.kill(pid, 0)).toThrow();
            }
            await rm(root, { recursive: true, force: true });
        }
    }, 20_000);
}
