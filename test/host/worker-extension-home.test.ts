import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { startWorker } from "../../src/host/worker/handle.ts";
import { EXTENSION_DATA_DIRECTORY, VERA_HOME_ENV } from "../../src/profile-paths.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const STORAGE_MARK = fileURLToPath(
    new URL("./fixtures/storage-mark", import.meta.url),
);
const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-session-start-adapter.ts", import.meta.url),
);

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the extension marker");
        }
        await Bun.sleep(10);
    }
}

test("a worker extension writes under the host's explicit home", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-worker-home-")),
    );
    const ambientHome = join(root, "ambient-home");
    const explicitHome = join(root, "explicit-home");
    await mkdir(ambientHome, { recursive: true });
    await mkdir(explicitHome, { recursive: true });
    const previousHome = process.env[VERA_HOME_ENV];
    process.env[VERA_HOME_ENV] = ambientHome;

    const sessionPath = join(root, "session.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "storage-mark",
        cwd: root,
    });
    const handle = await startWorker({
        store,
        session: await readSessionSeed(sessionPath),
        model: "test",
        adapter: {
            module: ADAPTER,
            options: { requestPath: join(root, "requests.jsonl") },
        },
        data: { approvalMode: "full_access" },
        extensions: [{ path: STORAGE_MARK, enabled: true, config: null }],
        home: explicitHome,
        onUpdate: () => undefined,
    });

    try {
        const profileMarker = join(
            explicitHome,
            EXTENSION_DATA_DIRECTORY,
            "test.storage-mark",
            "activated.txt",
        );
        const machineMarker = join(
            explicitHome,
            "machine",
            EXTENSION_DATA_DIRECTORY,
            "test.storage-mark",
            "activated.txt",
        );
        await waitFor(() => existsSync(profileMarker) && existsSync(machineMarker));
        expect(existsSync(profileMarker)).toBe(true);
        expect(existsSync(machineMarker)).toBe(true);
        expect(existsSync(join(
            ambientHome,
            EXTENSION_DATA_DIRECTORY,
            "test.storage-mark",
            "activated.txt",
        ))).toBe(false);
    } finally {
        handle.kill();
        await handle.outcome.catch(() => undefined);
        if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previousHome;
        await rm(root, { recursive: true, force: true });
    }
});
