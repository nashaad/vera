import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHostServer } from "../../src/host/server.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { operateModelsThroughHost } from "../../src/host/model-operation-client.ts";
import { connectHost } from "../../src/host/connection.ts";

test("model operations reject malformed requests", () => {
    for (const operation of [
        { operation: "oops", models: [{ provider: "p", model: "m" }] },
        { operation: "keep", models: [] },
        { operation: "verify", models: [{ provider: "p", model: "" }] },
        { operation: "rename", models: [{ provider: "p", model: "m" }] },
    ]) expect(parseHostRequest(JSON.stringify({ type: "model_operation", ...operation }))).toBeUndefined();
});

test("unattached model operations stream results before completion", async () => {
    const root = await mkdtemp("/tmp/vera-model-rpc-");
    const socketPath = join(root, "host.sock");
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"),
        operateModels: async (request, onResult) => {
            expect(request.operation).toBe("verify");
            for (const model of request.models) onResult({ ...model, status: "passed" });
            return undefined;
        } });
    try {
        const seen: string[] = [];
        await operateModelsThroughHost(socketPath, { operation: "verify", models: [
            { provider: "p", model: "one" }, { provider: "p", model: "two" },
        ] }, (row) => seen.push(row.model));
        expect(seen).toEqual(["one", "two"]);
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("closing the client does not cancel a verification operation", async () => {
    const root = await mkdtemp("/tmp/vera-model-detach-");
    const socketPath = join(root, "host.sock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let finished!: () => void;
    const finishedPromise = new Promise<void>((resolve) => { finished = resolve; });
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"),
        operateModels: async (request, onResult) => {
            started(); await gate;
            onResult({ ...request.models[0]!, status: "passed" }); finished();
            return undefined;
        } });
    try {
        const connection = await connectHost({ socketPath });
        await connection.send({ type: "model_operation", operation: "verify", models: [{ provider: "p", model: "m" }] });
        await startedPromise;
        connection.close(); release(); await finishedPromise;
    } finally { release(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
