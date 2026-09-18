import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHostServer } from "../../src/host/server.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";

test("extension requests need an extension, a name, and a payload", () => {
    expect(parseHostRequest(JSON.stringify({ type: "extension_request", extensionId: "vera.web-search", name: "providers", payload: null })))
        .toEqual({ type: "extension_request", extensionId: "vera.web-search", name: "providers", payload: null });
    expect(parseHostRequest(JSON.stringify({ type: "extension_request", extensionId: "vera.web-search", name: "providers" }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({ type: "extension_request", extensionId: "vera.web-search", name: "", payload: 1 }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({ type: "extension_request", name: "providers", payload: 1 }))).toBeUndefined();
});

test("extension requests return the answer, the refusal, or cancel", async () => {
    const root = await mkdtemp("/tmp/vera-ext-req-");
    const socketPath = join(root, "host.sock");
    let aborted!: () => void;
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const server = await startHostServer({ socketPath, lockPath: join(root, "host.json"),
        handleExtensionRequest: async (extensionId, name, payload, signal) => {
            if (name === "echo") return { extensionId, payload };
            if (name === "slow") {
                started();
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                aborted();
                return null;
            }
            throw new Error(`No ${name} here`);
        } });
    try {
        expect(await requestExtensionThroughHost(socketPath, "example.a", "echo", { n: 1 }, new AbortController().signal))
            .toEqual({ extensionId: "example.a", payload: { n: 1 } });
        const refused = await requestExtensionThroughHost(socketPath, "example.a", "nope", null, new AbortController().signal)
            .then(() => "answered", (error: Error) => error.message);
        expect(refused).toBe("No nope here");
        const controller = new AbortController();
        const pending = requestExtensionThroughHost(socketPath, "example.a", "slow", null, controller.signal);
        await startedPromise;
        controller.abort();
        expect(await pending.then(() => "answered", () => "cancelled")).toBe("cancelled");
        await abortedPromise;
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
