import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { WorkerSessionStore } from "../../src/host/worker/session.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

test("a worker whose append the host rejects gets the rejection and the session file stays valid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-append-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const host = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work/vera",
    });

    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const hostPipe = createJsonPipe(
        { input: toHost, output: toWorker },
        { onRequest: (body) => server.handleRequest(body) },
    );
    const workerPipe = createJsonPipe({ input: toWorker, output: toHost });
    const server = createWorkerBoundaryServer({
        pipe: hostPipe,
        store: host,
        services: {},
    });

    const header = JSON.parse(
        readFileSync(path, "utf8").split("\n")[0] as string,
    ) as Record<string, unknown>;
    const worker = WorkerSessionStore.seed(path, header);
    worker.setAppender(async (record) => {
        const reply = await workerPipe.request({
            method: "session.append",
            record,
        }) as { readonly lineNumber: number };
        return reply.lineNumber;
    });

    try {
        await worker.appendMessage(userMessage("one"));
        await host.appendMessage(userMessage("written by the host"));
        const before = readFileSync(path, "utf8");

        await expect(worker.appendMessage(userMessage("from a stale view")))
            .rejects.toThrow(/line 4 does not extend the active head/);

        expect(readFileSync(path, "utf8")).toBe(before);
        expect((await SessionStore.open(path)).messages().length).toBe(2);
        expect(host.appendedLineCount()).toBe(3);
    } finally {
        workerPipe.close();
        hostPipe.close();
        toWorker.destroy();
        toHost.destroy();
    }
});
