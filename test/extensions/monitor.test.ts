import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORE_EXTENSIONS_DIRECTORY, includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { executeToolHandler } from "../../src/tools/execute.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const monitorPath = join(CORE_EXTENSIONS_DIRECTORY, "monitor");

test("@core bundled monitor launches the bound command and wakes only its owner", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-crow-monitor-"));
    const inbox = Inbox.open(join(workspace, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"));
    const extensions = await startExtensionRegistry({
        extensions: [{ path: monitorPath, enabled: true, config: null }],
        storageRoots: { profile: workspace, machine: workspace },
    });
    const observations = new ProcessObservationCoordinator(inbox, delivery, extensions);
    const processes = new ManagedProcessRegistry({
        onObservationStarted: async (start) => observations.start("crow-executor", start),
        onObservationSettled: async (settlement) => observations.settle("crow-executor", settlement),
    });
    const runtime = new ToolRuntime(workspace, undefined, undefined, undefined, undefined, processes.scope("crow-owner"));
    runtime.sessionId = "crow-owner";
    runtime.readApprovalMode = () => "auto";
    const woken: string[] = [];
    delivery.attach({
        label: "crow-owner", session: "crow-owner", initialOffset: 0, notify: () => {},
        canStartTurn: () => true, startTurn: () => { woken.push("owner"); },
    });
    delivery.attach({
        label: "crow-other", session: "crow-other", initialOffset: 0, notify: () => {},
        canStartTurn: () => true, startTurn: () => { woken.push("other"); },
    });
    try {
        expect(includedExtensionConfigs([]).some((config) => config.path === monitorPath)).toBe(true);
        const result = await executeToolHandler({
            type: "tool_call", id: "crow-call", name: "monitor",
            input: { command: "printf 'crow found the map\\n'; exit 7", description: "Crow checks the hold" },
        }, runtime, new AbortController().signal, extensions.tools());
        expect(result.kind).toBe("output");
        if (result.kind !== "output") throw new Error("Monitor did not return output");
        expect(result.isError).toBe(false);
        expect(result.output).toContain("Started process");
        await waitFor(() => woken.length > 0);
        expect(woken).toEqual(["owner"]);
        const entries = inbox.readAfter(0, { limit: 10, addresses: ["crow-owner"] });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: "process.exited", address: "crow-owner" });
        expect(entries[0]!.source).toMatch(/^vera\/process\/p-/);
        expect(inbox.isDurablyAdmitted(entries[0]!.seq)).toBe(true);
        const payload = JSON.parse(entries[0]!.payload);
        expect(payload.text).toContain("Crow checks the hold");
        expect(payload.text).toContain("Exited with code 7");
        expect(payload.text).toContain("crow found the map");
        expect(inbox.processObservations.pending("", 10)).toEqual([]);
        expect(inbox.processObservations.get(entries[0]!.source.slice("vera/process/".length))).toBeUndefined();
    } finally {
        await runtime.close();
        await processes.close();
        await extensions.close();
        delivery.close();
        inbox.close();
        rmSync(workspace, { recursive: true, force: true });
    }
}, 10_000);

test("@core disabled monitor has no tool or process outcome formatter", async () => {
    const registry = await startExtensionRegistry({
        extensions: [{ path: monitorPath, enabled: false, config: null }],
    });
    try {
        expect(registry.tools().some((tool) => tool.definition.name === "monitor")).toBe(false);
        expect(await registry.formatProcessOutcome("vera.monitor", {
            processId: "p-crow", description: "Crow checks the hold", pid: 42,
            startedAt: "2026-11-16T12:00:00.000Z", outcome: "interrupted",
        })).toBeUndefined();
    } finally {
        await registry.close();
    }
});

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Monitor wake timed out");
        await Bun.sleep(5);
    }
}
