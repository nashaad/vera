import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import {
    appendRestartRecord,
    defaultRestartRecordPath,
    listRestartRecords,
} from "../../src/store/restart-records.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const at = "2026-11-07T10:00:00.000Z";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "trashing a session clears its restart records and keeps the others",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-restart-trash-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const recordPath = defaultRestartRecordPath(root);
        appendRestartRecord({ session_id: "saved", cause: "crash", at }, recordPath);
        appendRestartRecord({ session_id: "other", cause: "crash", at }, recordPath);
        appendRestartRecord({ session_id: "saved", cause: "stop", at }, recordPath);
        const host = await startResidentHost({
            home: root,
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
            eventLogDirectory: join(root, "logs"),
            trashSessionArtifacts: (artifacts) =>
                trashSessionArtifacts(artifacts, {
                    moveToTrash: async () => {},
                }),
        });
        const sessionPath = join(sessionDirectory, "saved.jsonl");

        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");

            expect(await trashSessionThroughHost(socketPath, "saved"))
                .toEqual({ status: "trashed" });

            expect(await stat(sessionPath).then(() => true, () => false))
                .toBe(false);
            expect(listRestartRecords(recordPath)).toEqual([
                { session_id: "other", cause: "crash", at },
            ]);
            expect((await listAgentsThroughHost(socketPath)).map((agent) =>
                agent.id
            )).not.toContain("saved");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
