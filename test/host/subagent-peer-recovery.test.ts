import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { defaultSessionDirectory, SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

const config = { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "ask" } as const;

for (const targetOwner of ["local", "worker"] as const) {
    socketTest(`@core agent_send guides only the owner of a ${targetOwner} child`, async () => {
        await mkdir(join(tmpdir(), "vera-dev"), { recursive: true });
        const home = await mkdtemp(join(tmpdir(), "vera-dev", "peer-child-"));
        const host = await startResidentHost({
            home, config, inProcessWorker: true, createAdapter: () => new FauxAdapter([]),
        });
        try {
            const parent = await host.registry.create({ workspace: home });
            const stranger = await host.registry.create({ workspace: home });
            const childId = `crow-child-${targetOwner}`;
            const childPath = join(defaultSessionDirectory(home), `${childId}.jsonl`);
            if (targetOwner === "local") {
                await host.registry.createWithKind(
                    { id: childId, workspace: home, sessionPath: childPath },
                    "background", { approvalMode: "ask", parentId: parent.id },
                );
            } else {
                await SessionStore.create(childPath, { sessionId: childId, cwd: home, parentId: parent.id });
                const connection = await connectHost({ socketPath: host.server.socketPath });
                try {
                    await connection.send({ type: "locate_agent", agent_id: childId });
                    expect(await connection.receive()).toMatchObject({ type: "agent_location", worker_id: "w0" });
                } finally {
                    connection.close();
                }
            }
            const send = (callerId: string, to: string) => host.registry.applyAgentSendEffect(callerId, {
                type: "agent_send", to, text: "Check the crow's map.",
            });
            expect(await send(parent.id, childId)).toMatchObject({
                isError: true,
                output: `Async subagent ${childId} is your child. Use message_subagent to send it more work.`,
            });
            expect(await send(stranger.id, childId)).toMatchObject({
                isError: true, output: `No native Vera participant ${childId}.`,
            });
            expect(await send(parent.id, "unknown-crow")).toMatchObject({
                isError: true, output: "No native Vera participant unknown-crow.",
            });
            expect(await host.registry.subagentSessions!.closeSubagent(parent.id, childId)).toMatchObject({ status: "closed" });
            expect(await send(parent.id, childId)).toMatchObject({
                isError: true, output: `No native Vera participant ${childId}.`,
            });
        } finally {
            await host.close();
            await rm(home, { recursive: true, force: true });
        }
    }, 20_000);
}
