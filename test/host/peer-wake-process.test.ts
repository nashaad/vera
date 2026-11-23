import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { blockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

socketAndLoopbackTest("@core parked peer wakes through a separate worker process", async () => {
    const home = await mkdtemp(join(tmpdir(), "pw-process-"));
    const inboxPath = join(home, "inbox-test.db");
    const requests: string[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests.push(await request.text());
            const chunk = {
                id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta: { role: "assistant", content: "The crow heard the message." }, finish_reason: "stop" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerSocket: string | undefined;
    try {
        const config = {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        } as const;
        await writeFile(join(home, "config.json"), JSON.stringify(config));
        host = await startResidentHost({
            home, inboxPath, skipStartupDiscovery: true, processWorker: true,
            arcConfigPath: join(home, "no-arc-config"),
            importRoots: { claudeCode: join(home, "no-claude"), codex: join(home, "no-codex") },
            config,
        });
        const socket = host.server.socketPath;
        const sender = await host.registry.create({ workspace: home });
        const sessionDirectory = defaultSessionDirectory(home);
        await mkdir(sessionDirectory, { recursive: true });
        const createSession = async (id: string, mode: "auto" | "ask") => {
            const path = join(sessionDirectory, `${id}.jsonl`);
            const store = await SessionStore.create(path, { sessionId: id, cwd: home });
            await store.appendIdentity({ name: `${id}:1234`, key: `${id}:1234` });
            await store.appendApprovalMode(mode);
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "An earlier conversation." }] });
            return await resumeAgentThroughHost(socket, path);
        };
        const recipient = await createSession("recipient-crow", "auto");
        const ask = await createSession("ask-crow", "ask");
        const blocked = await createSession("blocked-crow", "auto");
        expect(recipient.location?.worker_id).toBe("w0");
        workerSocket = recipient.location!.socket_path;
        const identity = await requestHostIdentity(workerSocket);
        expect(identity?.pid).toBeDefined();
        expect(identity!.pid).not.toBe(process.pid);
        const rows = await listAgentsThroughHost(socket);
        const recipientPath = rows.find((row) => row.id === recipient.id)!.session_path;
        expect(await blockSessionThroughHost(socket, {
            targetAgentId: blocked.id, sessionIds: [blocked.id], reason: null,
        })).toMatchObject({ status: "blocked" });
        for (const id of [recipient.id, ask.id, blocked.id]) {
            expect(await closeAgentThroughHost(socket, id)).toMatchObject({ status: "closed" });
        }
        const parkedSummaries = await listAgentsThroughHost(socket);
        const roster = JSON.parse((await host.registry.applyAgentRosterEffect(sender.id, false)).output);
        for (const id of [recipient.id, ask.id, blocked.id]) {
            const summary = parkedSummaries.find((row) => row.id === id)!;
            expect(summary).toMatchObject({ status: "completed", live: false });
            expect(summary.name).toBeUndefined();
            expect(roster.participants.filter((row: { participant_id: string }) => row.participant_id === id))
                .toMatchObject([{ participant_id: id, name: `${id}:1234`, status: "parked", live: false }]);
        }
        const send = (to: string, text: string) => host!.registry.applyAgentSendEffect(sender.id, { type: "agent_send", to, text });
        for (const [id, reason] of [[ask.id, "approval_mode"], [blocked.id, "blocked"]] as const) {
            const result = await send(id, `The crow's ${reason} note.`);
            expect(result.isError).toBe(false);
            expect(JSON.parse(result.output)).toMatchObject({ stored: true, delivered: false, recipient_live: false, not_delivered_because: reason });
            expect((await listAgentsThroughHost(socket)).find((row) => row.id === id)?.live).toBe(false);
        }
        const result = await send(recipient.id, "The crow found the map.");
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.output)).toMatchObject({ stored: true, delivered: true });
        const deadline = Date.now() + 10_000;
        let transcript = "";
        while (Date.now() < deadline) {
            transcript = await readFile(recipientPath, "utf8");
            if (transcript.includes("The crow heard the message.")) break;
            await Bun.sleep(20);
        }
        expect(transcript).toContain("<agent_message>");
        expect(transcript).toContain("The crow found the map.");
        expect(transcript).toContain("The crow heard the message.");
        expect(requests.filter((body) => body.includes("<agent_message>") && body.includes("The crow found the map."))).toHaveLength(1);
        expect((await listAgentsThroughHost(socket)).filter((row) => row.id === recipient.id && row.live)).toHaveLength(1);
        const inbox = Inbox.open(inboxPath);
        try {
            const entries = inbox.readAfter(0, { limit: 20 });
            for (const id of [recipient.id, ask.id, blocked.id]) {
                expect(entries.filter((entry) => entry.address === id && entry.kind === "peer.message")).toHaveLength(1);
            }
            for (const id of [ask.id, blocked.id]) {
                const entry = entries.find((item) => item.address === id && item.kind === "peer.message")!;
                expect(inbox.listConsumers().filter((item) => item.consumer.label === id).every((item) => item.seq < entry.seq)).toBe(true);
            }
        } finally {
            inbox.close();
        }

        const racing = await createSession("racing-crow", "auto");
        const racingPath = (await listAgentsThroughHost(socket)).find((row) => row.id === racing.id)!.session_path;
        expect(await closeAgentThroughHost(socket, racing.id)).toMatchObject({ status: "closed" });
        const [resumed, sent] = await Promise.all([
            resumeAgentThroughHost(socket, racingPath),
            send(racing.id, "The crow found the compass."),
        ]);
        expect(resumed.id).toBe(racing.id);
        expect(resumed.location?.worker_id).toBe("w0");
        expect(sent.isError).toBe(false);
        expect(JSON.parse(sent.output)).toMatchObject({ stored: true, delivered: true });
        const raceDeadline = Date.now() + 10_000;
        while (Date.now() < raceDeadline && !requests.some((body) => body.includes("The crow found the compass."))) {
            await Bun.sleep(20);
        }
        expect(requests.filter((body) => body.includes("<agent_message>") && body.includes("The crow found the compass."))).toHaveLength(1);
        expect((await listAgentsThroughHost(socket)).filter((row) => row.id === racing.id && row.live)).toHaveLength(1);
    } finally {
        try {
            await host?.close();
            if (workerSocket !== undefined) expect(await requestHostIdentity(workerSocket).catch(() => undefined)).toBeUndefined();
        } finally {
            stub.stop(true);
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);
