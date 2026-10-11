import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VeraConfig } from "../../src/config.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentRegistryOptions } from "../../src/host/agent-registry/support.ts";
import { createExtensionHostServices } from "../../src/host/extension-host-services.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import type { ModelAdapter, ModelMessage, ModelTool } from "../../src/model/types.ts";
import { defaultSessionPath, SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import explorerAdapter from "./fixtures/worker-explorer-adapter.ts";

interface RecordedRequest {
    readonly model: string;
    readonly system: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
}

const QUESTION = "Find the appointment date in record.txt.";

for (const worker of [false, true]) {
    test(`an investigation runs explorer read-only under the session with worker=${worker}`, async () => {
        const voyage = await openVoyage((requestsPath) => explorerAdapter({ requestsPath }), { worker });
        try {
            const parentBefore = await readFile(voyage.parentPath, "utf8");
            const result = await voyage.services.investigate(
                { sessionId: "parent", question: QUESTION, timeoutMs: 15_000 },
                new AbortController().signal,
            );

            expect(result).toMatchObject({
                outcome: "answered",
                text: "The appointment moved to Friday (record.txt:2).",
            });
            const requests: RecordedRequest[] = (await readFile(voyage.requestsPath, "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line));
            expect(requests.map((request) => request.model)).toEqual(["small", "small"]);
            expect(requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(["grep", "list", "read"]);
            expect(requests[0]!.system).toContain("Distinguish evidence from inference.");
            expect(JSON.stringify(requests[0]!.messages)).toContain(QUESTION);
            expect(JSON.stringify(requests[1]!.messages)).toContain("The appointment moved to Friday.");

            const run = await SessionStore.open(defaultSessionPath(result.runSessionId!));
            expect(run.header.parentId).toBe("parent");
            expect(run.approvalMode()).toBe("readonly");
            expect(run.selectedAgent()?.snapshot.name).toBe("explorer");
            expect(await readFile(voyage.parentPath, "utf8")).toBe(parentBefore);
        } finally {
            await voyage.close();
        }
    }, 20_000);
}

test("an investigation that outlasts its timeout ends timed_out, and a cancelled one ends cancelled", async () => {
    const voyage = await openVoyage(() => stalling());
    try {
        const timedOut = await voyage.services.investigate(
            { sessionId: "parent", question: QUESTION, timeoutMs: 50 },
            new AbortController().signal,
        );
        expect(timedOut.outcome).toBe("timed_out");
        expect(timedOut.text).toBe("");

        const controller = new AbortController();
        const pending = voyage.services.investigate(
            { sessionId: "parent", question: QUESTION, timeoutMs: 15_000 },
            controller.signal,
        );
        setTimeout(() => controller.abort(), 50);
        const cancelled = await pending;
        expect(cancelled.outcome).toBe("cancelled");
        expect(cancelled.text).toBe("");
    } finally {
        await voyage.close();
    }
});

test("an investigation needs an open session and the explorer agent", async () => {
    const voyage = await openVoyage(() => new FauxAdapter([]), { agents: false });
    try {
        await expect(voyage.services.investigate(
            { sessionId: "parrot", question: QUESTION, timeoutMs: 1_000 },
            new AbortController().signal,
        )).rejects.toThrow("Session parrot is not open");
        expect(await voyage.services.investigate(
            { sessionId: "parent", question: QUESTION, timeoutMs: 1_000 },
            new AbortController().signal,
        )).toEqual({ outcome: "failed", text: "", error: "No agent named explorer" });
    } finally {
        await voyage.close();
    }
});

async function openVoyage(
    createAdapter: (requestsPath: string) => ModelAdapter,
    options: { readonly worker?: boolean; readonly agents?: boolean } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "vera-investigate-"));
    const requestsPath = join(root, "requests.jsonl");
    const parentPath = join(root, "parent.jsonl");
    await writeFile(join(root, "record.txt"),
        "Appointment update\nThe appointment moved to Friday.\nRaw appendix.\n");
    const extensions = await startExtensionRegistry({
        extensions: includedExtensionConfigs([]),
    });
    const registryOptions: AgentRegistryOptions = {
        createAdapter: () => createAdapter(requestsPath),
        ...(options.worker === true ? {
            workerAdapterSpec: () => ({
                module: fileURLToPath(new URL("./fixtures/worker-explorer-adapter.ts", import.meta.url)),
                options: { requestsPath },
            }),
        } : {}),
        provider: "faux", model: "parent", approvalMode: "auto",
        ...(options.agents === false ? {} : { registeredAgents: extensions.agents() }),
        readPool: () => ["small", "parent"].map((model) => ({
            provider: "faux", model, label: model,
            available: true, verified: true,
            levels: [{ id: "low", label: "Low" }],
        })),
        readPolicy: () => ({
            assignments: { eco: [{ provider: "faux", model: "small", reasoningEffort: "low" }] },
        }),
    };
    const registry = new AgentRegistry(registryOptions);
    await registry.create({ id: "parent", workspace: root, sessionPath: parentPath });
    const services = createExtensionHostServices({
        registry,
        currentConfig: () => ({}) as VeraConfig,
        reachability: () => () => true,
        createAdapter: () => new FauxAdapter([]),
    });
    return {
        requestsPath, parentPath, services,
        async close() {
            await registry.close();
            await extensions.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}

// Holds every request open until it is aborted, then lets the faux stream fail it.
function stalling(): ModelAdapter {
    return {
        stream(request) {
            const stream = new ModelEventStream();
            void (async () => {
                await new Promise<void>((resolve) => {
                    if (request.signal === undefined || request.signal.aborted) return resolve();
                    request.signal.addEventListener("abort", () => resolve());
                });
                for await (const event of new FauxAdapter([]).stream(request)) {
                    stream.push(event);
                }
            })();
            return stream;
        },
    };
}
