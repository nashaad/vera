import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { blockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

for (const pool of [false, true]) {
    socketTest(`@core parked peer delivery and guards (${pool ? "worker router" : "workers zero"})`, async () => {
        const root = await mkdtemp(join(tmpdir(), "peer-wake-"));
        const sessionDirectory = defaultSessionDirectory(root);
        const inboxPath = join(root, "inbox-test.db");
        const oldPath = join(sessionDirectory, "old-crow.jsonl");
        await mkdir(sessionDirectory, { recursive: true });
        await SessionStore.create(oldPath, { sessionId: "old-crow", cwd: root });
        const failedStore = await SessionStore.create(join(sessionDirectory, "failed-crow.jsonl"), { sessionId: "failed-crow", cwd: root });
        await failedStore.appendIdentity({ name: "failed-crow:1234", key: "failed-crow:1234" });
        await failedStore.appendMessage({ role: "user", content: [{ type: "text", text: "An earlier conversation." }] });
        await failedStore.appendAgentFailure("failure", "The crow lost its chart.");
        const old = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000);
        await utimes(oldPath, old, old);
        const host = await startResidentHost({
            home: root,
            config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto", host: { workers: pool ? 1 : 0 } },
            inProcessWorker: pool,
            inboxPath,
            arcConfigPath: join(root, "no-arc-config"),
            importRoots: { claudeCode: join(root, "no-claude"), codex: join(root, "no-codex") },
            createAdapter: () => new FauxAdapter([{
                role: "assistant", content: [{ type: "text", text: "The crow heard the message." }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(), stopReason: "stop",
            }]),
        });
        try {
            const sender = await host.registry.create({ workspace: root });
            const createSession = async (id: string, mode: "auto" | "ask") => {
                const path = join(sessionDirectory, `${id}.jsonl`);
                const store = await SessionStore.create(path, { sessionId: id, cwd: root });
                await store.appendIdentity({ name: `${id}:1234`, key: `${id}:1234` });
                await store.appendApprovalMode(mode);
                await store.appendMessage({ role: "user", content: [{ type: "text", text: "An earlier conversation." }] });
                return await resumeAgentThroughHost(host.server.socketPath, path);
            };
            const recipient = await createSession("recipient-crow", "auto");
            const ask = await createSession("ask-crow", "ask");
            const blocked = await createSession("blocked-crow", "auto");
            const hopLimited = await createSession("hop-crow", "auto");
            const rows = await listAgentsThroughHost(host.server.socketPath);
            const recipientPath = rows.find((row) => row.id === recipient.id)!.session_path;
            const askPath = rows.find((row) => row.id === ask.id)!.session_path;
            expect(await blockSessionThroughHost(host.server.socketPath, {
                targetAgentId: blocked.id, sessionIds: [blocked.id], reason: null,
            })).toMatchObject({ status: "blocked" });
            for (const id of [recipient.id, ask.id, blocked.id, hopLimited.id]) {
                expect(await closeAgentThroughHost(host.server.socketPath, id)).toMatchObject({ status: "closed" });
            }
            const parkedSummaries = await listAgentsThroughHost(host.server.socketPath);
            const roster = JSON.parse((await host.registry.applyAgentRosterEffect(sender.id, false)).output);
            for (const id of [recipient.id, ask.id, blocked.id]) {
                const summary = parkedSummaries.find((row) => row.id === id)!;
                expect(summary).toMatchObject({ status: "completed", live: false });
                expect(summary.name).toBeUndefined();
                expect(roster.participants.filter((row: { participant_id: string }) => row.participant_id === id))
                    .toMatchObject([{ participant_id: id, name: `${id}:1234`, live: false, status: "parked" }]);
            }
            expect(parkedSummaries.find((row) => row.id === "failed-crow"))
                .toMatchObject({ status: "completed", live: false });
            for (const id of ["old-crow", "failed-crow"]) {
                expect(roster.participants.some((row: { participant_id: string }) => row.participant_id === id)).toBe(false);
            }
            const send = (to: string, text: string) => host.registry.applyAgentSendEffect(sender.id, { type: "agent_send", to, text });
            for (const id of ["old-crow", "failed-crow"]) {
                const refused = await send(id, "The old chart.");
                expect(refused.isError).toBe(true);
                expect(refused.output).toContain("No native Vera participant");
            }
            for (const [id, reason] of [[ask.id, "approval_mode"], [blocked.id, "blocked"]] as const) {
                const result = await send(id, `Message for ${reason}`);
                expect(result.isError).toBe(false);
                expect(JSON.parse(result.output)).toMatchObject({ stored: true, recipient_live: false, delivered: false, not_delivered_because: reason });
                expect((await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === id)?.live).toBe(false);
            }
            const senderEntry = host.registry.agents.get(sender.id)!;
            senderEntry.peerHop = 3;
            const hopResult = await send(hopLimited.id, "The hop-limited note.");
            expect(JSON.parse(hopResult.output)).toMatchObject({ stored: true, delivered: false, not_delivered_because: "hop_limit" });
            expect((await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === hopLimited.id)?.live).toBe(false);
            senderEntry.peerHop = 0;
            const sent = await send(recipient.id, "The crow found the map.");
            expect(sent.isError).toBe(false);
            expect(JSON.parse(sent.output)).toMatchObject({ stored: true, delivered: true });
            const deadline = Date.now() + 5_000;
            let transcript = "";
            while (Date.now() < deadline) {
                transcript = await readFile(recipientPath, "utf8");
                if (transcript.includes("The crow heard the message.")) break;
                await Bun.sleep(20);
            }
            expect(transcript).toContain("<agent_message>");
            expect(transcript).toContain("The crow found the map.");
            expect(transcript).toContain("The crow heard the message.");
            const after = await listAgentsThroughHost(host.server.socketPath);
            expect(after.filter((row) => row.id === recipient.id && row.live)).toHaveLength(1);
            const liveRoster = JSON.parse((await host.registry.applyAgentRosterEffect(sender.id, false)).output);
            expect(liveRoster.participants.filter((row: { participant_id: string }) => row.participant_id === recipient.id))
                .toMatchObject([{ participant_id: recipient.id, live: true }]);
            const inbox = Inbox.open(inboxPath);
            try {
                const entries = inbox.readAfter(0, { limit: 20 });
                for (const id of [ask.id, blocked.id, recipient.id]) {
                    expect(entries.filter((entry) => entry.address === id && entry.kind === "peer.message")).toHaveLength(1);
                }
                for (const id of [ask.id, blocked.id]) {
                    const entry = entries.find((item) => item.address === id && item.kind === "peer.message")!;
                    const offsets = inbox.listConsumers().filter((item) => item.consumer.label === id);
                    expect(offsets.every((item) => item.seq < entry.seq)).toBe(true);
                }
            } finally {
                inbox.close();
            }
            if (!pool) {
                await resumeAgentThroughHost(host.server.socketPath, askPath);
                const attachment = host.registry.agents.get(ask.id)!.agent.attach();
                try {
                    let question;
                    do {
                        question = await attachment.receive(AbortSignal.timeout(5_000));
                    } while (question.type !== "ui_request");
                    expect(question).toMatchObject({ request: { type: "user_question", outOfBand: true } });
                } finally {
                    attachment.detach();
                }
                expect(await closeAgentThroughHost(host.server.socketPath, recipient.id)).toMatchObject({ status: "closed" });
                for (let count = 1; count < 6; count += 1) {
                    const result = await send(recipient.id, `Wake number ${count + 1}.`);
                    expect(JSON.parse(result.output)).toMatchObject({ stored: true, delivered: true });
                    const until = Date.now() + 5_000;
                    let responses = 0;
                    while (Date.now() < until) {
                        const content = await readFile(recipientPath, "utf8");
                        responses = content.split("The crow heard the message.").length - 1;
                        if (responses >= count + 1) break;
                        await Bun.sleep(20);
                    }
                    expect(responses).toBeGreaterThanOrEqual(count + 1);
                    expect(await closeAgentThroughHost(host.server.socketPath, recipient.id)).toMatchObject({ status: "closed" });
                }
                const limited = await send(recipient.id, "The seventh wake waits.");
                expect(JSON.parse(limited.output)).toMatchObject({
                    stored: true, delivered: false, recipient_live: false, not_delivered_because: "rate_limit",
                });
                expect((await listAgentsThroughHost(host.server.socketPath)).find((row) => row.id === recipient.id)?.live).toBe(false);
            }
        } finally {
            try {
                await host.close();
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    }, 30_000);
}
