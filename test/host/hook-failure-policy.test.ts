import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { projectTranscript } from "../../src/engine/protocol.ts";
import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { startSessionHost } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const cases = [
    {
        name: "a loaded deny hook stops the tool and records the block in the transcript",
        registration: 'vera.hooks.registerPreToolUse(() => { throw new Error("lost map"); }, { onFailure: "deny" });',
        output: "Extension test.crow's pre_tool_use hook failed (threw: lost map) and denies on failure, so this tool call did not run.",
    },
    {
        name: "an undeclared non-JSON result keeps the generic tool block",
        registration: 'vera.hooks.registerPreToolUse(() => ({ power: "mutate", input: { value: NaN } }));',
        output: "pre_tool_use hook failed: Hook data at $.input.value must contain a finite number",
    },
];

for (const scenario of cases) test(scenario.name, async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "vera-dev", "hookfail-host-"));
    const previousHome = process.env.VERA_HOME;
    const previousInstance = process.env.VERA_DEV_INSTANCE;
    process.env.VERA_HOME = root;
    process.env.VERA_DEV_INSTANCE = "hookfail dev";
    const extension = join(root, "extension");
    const marker = join(root, "tool-ran");
    mkdirSync(extension);
    writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.crow", version: "1.0.0", sdk: "1", entrypoint: "./extension.ts",
        capabilities: ["hooks.pre_tool_use"],
    }));
    writeFileSync(join(extension, "extension.ts"), `export function activate(vera) { ${scenario.registration} }`);
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "bash", input: { command: `touch ${JSON.stringify(marker)}` } }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The chest stayed closed." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const config = {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "full_access",
        extensions: [{ path: extension, enabled: true, config: null }],
    } as const;
    const inbox = Inbox.open(join(root, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(createConsumerRegistry(inbox));
    let host: Awaited<ReturnType<typeof startSessionHost>> | undefined;
    try {
        host = await startSessionHost({
            sessions: "all",
            config,
            currentConfig: () => config,
            currentReachability: () => () => true,
            home: root,
            configPath: join(root, "config.json"),
            cacheDirectory: join(root, "catalog"),
            sessionDirectory: join(root, "sessions"),
            sessionIdentityReservationRoot: root,
            blockedDirectory: join(root, "blocked"),
            modelFailureLedgerPath: join(root, "failures.jsonl"),
            authStorage: createAuthStorage({ path: join(root, "auth.json") }),
            createAdapter: () => new FauxAdapter([response, finalResponse]),
            hostLog: () => {},
            startupLog: () => {},
            startupFindings: new StartupFindings(),
            timed: async (_phase, run) => await run(),
            createServices: () => ({ models: {}, inboxDelivery: delivery }),
            turnsHeld: () => false,
            inboxActorForSession: () => null,
            annexUrl: () => undefined,
            forgetRestartRecords: () => {},
            recentScheduleRuns: () => [],
            onWorkChanged: () => () => {},
        });
        host.startStorage();
        expect(host.extensions.preToolUseHooks()).toHaveLength(1);
        const agent = await host.registry.create({
            id: "hook-failure",
            workspace: root,
            sessionPath: join(root, "sessions", "hook-failure.jsonl"),
        });
        const attachment = agent.attach();
        try {
            expect((await attachment.receive()).type).toBe("history");
            attachment.send({ type: "prompt", content: "Open the chest." });
            while ((await attachment.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        } finally {
            attachment.detach();
        }
        const store = host.registry.agents.get(agent.id)!.store;
        expect(projectTranscript(store.messages())).toContainEqual(expect.objectContaining({
            kind: "tool_result",
            tool: "bash",
            output: scenario.output,
            isError: true,
            withheld: true,
        }));
        expect(existsSync(marker)).toBe(false);
    } finally {
        try {
            await host?.close();
        } finally {
            delivery.close();
            inbox.close();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousInstance === undefined) delete process.env.VERA_DEV_INSTANCE;
            else process.env.VERA_DEV_INSTANCE = previousInstance;
            rmSync(root, { recursive: true, force: true });
        }
    }
}, 20_000);
