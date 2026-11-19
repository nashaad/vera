import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { connectHost } from "../../src/host/connection.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { startHostServer } from "../../src/host/server.ts";
import { socketTest } from "../support/socket-probe.ts";

socketTest("feedback host request saves and rejects an unknown kind while old requests work", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-feedback-host-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const extensions = await startExtensionRegistry({ extensions: includedExtensionConfigs([]) });
    const socketPath = join(home, "host.sock");
    const host = await startHostServer({ socketPath, lockPath: join(home, "host.json"), handleExtensionRequest: (id, name, payload, signal) => extensions.handleRequest(id, name, payload, signal) });
    try {
        const signal = new AbortController().signal;
        const saved = await requestExtensionThroughHost(socketPath, "vera.feedback", "save", { kind: "bug", title: "Crow", description: "Stuck", source: "window" }, signal) as { path: string };
        expect(JSON.parse(readFileSync(join(saved.path, "report.json"), "utf8"))).toMatchObject({ title: "Crow", source: "window" });
        await expect(requestExtensionThroughHost(socketPath, "vera.feedback", "save", { kind: "other", title: "Crow", description: "", source: "window" }, signal)).rejects.toThrow("Choose Bug");
        const old = await connectHost({ socketPath });
        try {
            await old.send({ type: "host_identity" });
            expect(await old.receive()).toMatchObject({ type: "host_identity" });
        } finally { old.close(); }
    } finally {
        await host.close(); await extensions.close();
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});

socketTest("an older host refuses the extension request", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-feedback-old-host-"));
    const socketPath = join(home, "host.sock");
    const host = await startHostServer({ socketPath, lockPath: join(home, "host.json") });
    try {
        await expect(requestExtensionThroughHost(socketPath, "vera.feedback", "save", { kind: "bug", title: "Crow", description: "", source: "window" }, new AbortController().signal)).rejects.toThrow("This host cannot run extension requests");
    } finally { await host.close(); rmSync(home, { recursive: true, force: true }); }
});
