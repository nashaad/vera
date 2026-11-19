import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { HostRouter } from "../../src/host/pool/router.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const config = {
    schema_version: 1,
    provider: "stub",
    model: "stub-model",
    approval_mode: "auto",
    curated_models_url: "",
    providers: {},
} as const;

test("real store routing resolves symlink paths for a fileless resident session", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-path-real-store-"));
    const actual = join(home, "actual");
    const alias = join(home, "alias");
    const sessionPath = join(actual, "crow.jsonl");
    const aliasPath = join(alias, "crow.jsonl");
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    try {
        await mkdir(actual);
        await symlink(actual, alias, "dir");
        host = await startResidentHost({ home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true, config });
        const agent = await host.registry.create({
            id: "crow",
            workspace: home,
            sessionPath,
            approvalMode: "auto",
        });
        const router = host.registry.subagentSessions as HostRouter;

        expect(host.registry.agents.get(agent.id)!.store.isMaterialized()).toBe(false);
        expect(await Bun.file(sessionPath).exists()).toBe(false);
        expect(await router.inspectForResume(aliasPath)).toEqual({ id: "crow", sessionPath });
        expect(await router.inspectForResume(sessionPath)).toEqual({ id: "crow", sessionPath });
        expect(await router.find("host", "crow")).toBe(true);
        expect(await router.resume(aliasPath, new Set([sessionPath])))
            .toEqual({ id: "crow", workspace: home, sessionPath });
        expect(host.registry.agents.get(agent.id)!.store.isMaterialized()).toBe(false);
        expect(await Bun.file(sessionPath).exists()).toBe(false);

        await expect(router.inspectForResume(join(alias, "missing.jsonl")))
            .rejects.toMatchObject({ code: "ENOENT" });
        await expect(router.resume(aliasPath, new Set([join(home, "other.jsonl")])))
            .rejects.toThrow();
        expect(host.registry.agents.get(agent.id)!.store.isMaterialized()).toBe(false);
    } finally {
        await host?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("real store routing inspects and resumes an existing file through a symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-path-existing-"));
    const actual = join(home, "actual");
    const alias = join(home, "alias");
    const sessionPath = join(actual, "stored.jsonl");
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    try {
        await mkdir(actual);
        await symlink(actual, alias, "dir");
        await SessionStore.create(sessionPath, { sessionId: "stored", cwd: home });
        host = await startResidentHost({ home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true, config });
        const router = host.registry.subagentSessions as HostRouter;

        expect(await router.inspectForResume(join(alias, "stored.jsonl")))
            .toEqual({ id: "stored", sessionPath });
        const resumed = await router.resume(join(alias, "stored.jsonl"));
        expect(resumed).toMatchObject({ id: "stored", sessionPath });
        expect(await Bun.file(sessionPath).exists()).toBe(true);
        expect(router.isResident("stored")).toBe(true);
    } finally {
        await host?.close();
        await rm(home, { recursive: true, force: true });
    }
});
