import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { readTool } from "../../src/tools/files.ts";
import { ToolRuntime, type SkillFileCheck } from "../../src/tools/runtime.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-skill-check-"));
    directories.push(directory);
    const skillDirectory = join(directory, ".vera", "skills", "plunder");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), [
        "---",
        "name: plunder",
        "description: Take the loot.",
        "---",
        "BURIED TREASURE",
        "",
    ].join("\n"));
    return directory;
}

async function workerRuntime(
    directory: string,
    hostCheck: ((check: SkillFileCheck) => Promise<string | undefined>) | undefined,
): Promise<ToolRuntime> {
    const host = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "skill-check",
        cwd: directory,
    });
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const server = createWorkerBoundaryServer({
        pipe: createJsonPipe(
            { input: toHost, output: toWorker },
            {
                onRequest: (body) => server.handleRequest(body),
                onNotification: (body) => server.handleNotification(body),
            },
        ),
        store: host,
        services: hostCheck === undefined ? {} : { checkSkillFile: hostCheck },
    });
    const remote = createRemoteHostBoundary({
        pipe: createJsonPipe(
            { input: toWorker, output: toHost },
            { onNotification: (body) => remote.acceptNotification(body) },
        ),
        session: await readSessionSeed(host.path),
        offers: {
            approvalModeRead: false,
            modelSettings: false,
            selectedAgent: false,
        },
        capabilities: {
            updateApprovalMode: false,
            reviewToolCall: false,
            applyHostToolEffect: false,
            requestMissingSubagentConfiguration: false,
            applyCommittedToolEffect: false,
            loadContextualContributions: false,
            checkSkillFile: true,
            hooks: false,
            reviewLog: false,
            hasPendingDeliveryTurn: false,
            selectAgent: false,
            listSkills: false,
            invokeSkill: false,
        },
        state: { policy: {} },
        onReplicaDiverged: () => {},
    });
    const runtime = new ToolRuntime(directory);
    runtime.checkSkillFile = remote.boundary.checkSkillFile;
    return runtime;
}

function readSkill(runtime: ToolRuntime) {
    return readTool.execute(
        { path: join(".vera", "skills", "plunder", "SKILL.md") },
        runtime,
        new AbortController().signal,
    );
}

test("a worker reading a SKILL.md gets the host's answer", async () => {
    const directory = workspace();
    const checks: SkillFileCheck[] = [];
    const runtime = await workerRuntime(directory, async (check) => {
        checks.push(check);
        return "config.json could not be read: it is not valid JSON. Skills are off until it loads.";
    });
    runtime.allowedSkills = ["plunder"];
    runtime.userInvokedSkill = "plunder";

    const refused = await readSkill(runtime);

    expect(refused).toMatchObject({ kind: "output", isError: true });
    if (refused.kind === "output") {
        expect(refused.output).toContain("Skills are off until it loads.");
        expect(refused.output).not.toContain("BURIED TREASURE");
    }
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
        projectRoot: directory,
        allowedSkills: ["plunder"],
        isSubagent: false,
        userInvokedSkill: "plunder",
    });
    expect(checks[0]?.path).toEndWith(join(".vera", "skills", "plunder", "SKILL.md"));
});

test("a worker reads the SKILL.md when the host allows it", async () => {
    const runtime = await workerRuntime(workspace(), async () => undefined);

    const result = await readSkill(runtime);

    expect(result).toMatchObject({ kind: "output" });
    if (result.kind === "output") {
        expect(result.isError).not.toBe(true);
        expect(result.output).toContain("BURIED TREASURE");
    }
});

test("a host without the check fails the read instead of showing the skill", async () => {
    const runtime = await workerRuntime(workspace(), undefined);

    await expect(readSkill(runtime)).rejects.toThrow("The host offers no skill file check");
});
