import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";
import type {
    CommandSandbox,
    SandboxCommandRequest,
    SandboxInspector,
    SandboxPreparedCommand,
    SandboxPreparation,
    SandboxSettledCommand,
    SandboxUnwrappedCommand,
} from "../../src/sandbox/types.ts";
import type { SandboxInspection } from "../../src/sdk/sandbox.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-sandbox-seam-"));
    directories.push(directory);
    return directory;
}

interface FakeOptions {
    readonly refusal?: string;
    readonly unavailable?: boolean;
    readonly unwrapped?: boolean;
    readonly argv?: readonly string[];
}

class FakeSandbox implements CommandSandbox, SandboxInspector {
    readonly requests: SandboxCommandRequest[] = [];
    readonly unwrapped: SandboxUnwrappedCommand[] = [];
    private readonly warned = new Set<string>();

    constructor(private readonly options: FakeOptions = {}) {}

    inspection(): SandboxInspection {
        return {
            enabled: true,
            status: this.options.unavailable === true ? "unavailable" : "active",
            network: "open",
            allowedDomains: [],
            ...(this.options.unavailable === true ? { reason: "no bwrap here" } : {}),
        };
    }

    prepare(request: SandboxCommandRequest): Promise<SandboxPreparation> {
        this.requests.push(request);
        if (this.options.refusal !== undefined) {
            return Promise.resolve({ refusal: this.options.refusal });
        }
        if (this.options.unwrapped === true) {
            const unwrapped = {
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                commandId: `cmd-${this.requests.length}`,
                reason: "full_access" as const,
            };
            return Promise.resolve({ unwrapped });
        }
        if (this.options.unavailable === true) {
            const unwrapped = {
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                commandId: `cmd-${this.requests.length}`,
                reason: "unavailable" as const,
            };
            const first = !this.warned.has(request.sessionId);
            this.warned.add(request.sessionId);
            return Promise.resolve({
                unwrapped,
                ...(first
                    ? {
                        notice: "Sandbox unavailable: no bwrap here. "
                            + "Commands run unsandboxed.",
                    }
                    : {}),
            });
        }
        return Promise.resolve({
            prepared: {
                argv: this.options.argv ?? ["bash", "-c", `echo wrapped; ${request.command}`],
                env: request.env,
                commandId: `cmd-${this.requests.length}`,
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                command: request.command,
                violationsBefore: 0,
            },
        });
    }

    settle(prepared: SandboxPreparedCommand): Promise<SandboxSettledCommand> {
        return Promise.resolve({
            suffix: "\n\nBlocked by sandbox:\n  write /data/x",
            violations: [],
        });
    }

    settleSync(prepared: SandboxPreparedCommand): SandboxSettledCommand {
        return {
            suffix: "\n\nBlocked by sandbox:\n  write /data/x",
            violations: [],
        };
    }

    finishUnwrapped(unwrapped: SandboxUnwrappedCommand): void {
        this.unwrapped.push(unwrapped);
    }

    release(): void {}

    readonly ended: string[] = [];

    commandEnded(prepared: SandboxPreparedCommand): void {
        this.ended.push(prepared.commandId);
    }
}

async function run(
    sandbox: CommandSandbox,
    command: string,
    identity: {
        readonly sessionId: string;
        readonly toolCallId: string;
        readonly approvalMode?: string;
        readonly readRoots?: readonly string[];
    },
) {
    const registry = new ManagedProcessRegistry({ sandbox });
    return registry.scope(`${identity.sessionId}-scope`).run({
        command,
        cwd: workspace(),
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        interactive: false,
        sandbox: identity,
    });
}

test("@core sandbox seam spawns the wrapper and keeps the original command", async () => {
    const sandbox = new FakeSandbox();
    const result = await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-1",
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.output).toContain("wrapped");
    expect(result.snapshot.output).toContain("treasure");
    expect(result.snapshot.output).toContain("Blocked by sandbox:\n  write /data/x");
    expect(result.snapshot.command).toBe("echo treasure");
    expect(sandbox.requests[0]).toMatchObject({
        sessionId: "session-1",
        toolCallId: "call-1",
        command: "echo treasure",
    });
    // srt's per-command cleanup is released once the child has exited.
    expect(sandbox.ended).toEqual(["cmd-1"]);
});

test("@core sandbox seam hands the session's read roots to the sandbox", async () => {
    const sandbox = new FakeSandbox();
    await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-1",
        readRoots: ["/other/docs"],
    });
    expect(sandbox.requests[0]?.readRoots).toEqual(["/other/docs"]);
});

test("@core sandbox seam covers a command that names no session", async () => {
    const sandbox = new FakeSandbox();
    const registry = new ManagedProcessRegistry({ sandbox });
    const result = await registry.scope("standalone").run({
        command: "echo treasure",
        cwd: workspace(),
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        interactive: false,
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.output).toContain("wrapped");
    const request = sandbox.requests[0];
    expect(request?.sessionId).toBe(result.snapshot.processId);
    expect(request?.toolCallId).toBe(result.snapshot.processId);
    expect(request?.command).toBe("echo treasure");
});

test("@core sandbox seam refuses a command the wrapper cannot take", async () => {
    const sandbox = new FakeSandbox({
        refusal: "Sandbox could not wrap this command: nope.",
    });
    const result = await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-1",
    });
    expect(result).toEqual({
        kind: "rejected",
        reason: "Sandbox could not wrap this command: nope.",
    });
});

test("@core sandbox seam runs a full_access command unwrapped and logs it", async () => {
    const sandbox = new FakeSandbox({ unwrapped: true });
    const result = await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-1",
        approvalMode: "full_access",
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.snapshot.output).toContain("treasure");
    expect(result.snapshot.output).not.toContain("wrapped");
    expect(sandbox.unwrapped.at(-1)).toMatchObject({
        sessionId: "session-1",
        reason: "full_access",
    });
    expect(sandbox.requests[0]?.approvalMode).toBe("full_access");
});

test("@core sandbox seam warns once per session when the sandbox is unavailable", async () => {
    const sandbox = new FakeSandbox({ unavailable: true });
    const first = await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-1",
    });
    const second = await run(sandbox, "echo treasure", {
        sessionId: "session-1",
        toolCallId: "call-2",
    });
    const other = await run(sandbox, "echo treasure", {
        sessionId: "session-2",
        toolCallId: "call-3",
    });
    for (const result of [first, second, other]) {
        expect(result.kind).toBe("exited");
    }
    const output = (result: typeof first) =>
        result.kind === "exited" ? result.snapshot.output : "";
    expect(output(first)).toContain(
        "Sandbox unavailable: no bwrap here. Commands run unsandboxed.",
    );
    expect(output(second)).not.toContain("Sandbox unavailable:");
    expect(output(other)).toContain("Sandbox unavailable:");
    expect(sandbox.unwrapped).toHaveLength(3);
});

test("@core repeated process reads preserve sandbox outcomes", async () => {
    for (const unavailable of [false, true]) {
        const sandbox = new FakeSandbox({ unavailable });
        const registry = new ManagedProcessRegistry({ sandbox });
        const scope = registry.scope("replay");
        try {
            const started = await scope.run({
                command: "printf treasure",
                cwd: workspace(),
                env: { ...process.env, PATH: process.env.PATH ?? "" },
                interactive: false,
                yieldAfterMs: 0,
            });
            expect(started.kind).toBe("running");
            if (started.kind !== "running") throw new Error("expected process id");
            const deadline = Date.now() + 2_000;
            while (registry.hasLiveProcesses()) {
                if (Date.now() > deadline) throw new Error("process did not exit in time");
                await Bun.sleep(10);
            }
            const processId = started.snapshot.processId;
            const first = await scope.readSettled(processId);
            expect(first?.status).toBe("exited");
            expect(first?.output).toContain("treasure");
            expect(first?.output).toContain(unavailable
                ? "Sandbox unavailable: no bwrap here."
                : "Blocked by sandbox:");
            const reads = await Promise.all([
                scope.readSettled(processId),
                scope.readSettled(processId),
            ]);
            expect(reads).toEqual([first, first]);
            expect(scope.read(processId)).toEqual(first);
            expect(sandbox.unwrapped).toHaveLength(unavailable ? 1 : 0);
        } finally {
            await registry.close();
        }
        expect(sandbox.unwrapped).toHaveLength(unavailable ? 1 : 0);
    }
});

test("@core a worker session's boundary carries the process's sandbox", async () => {
    const directory = workspace();
    const host = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "seam",
        cwd: directory,
    });
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const sandbox = new FakeSandbox({ unavailable: true });
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
            checkSkillFile: false,
            hooks: false,
            reviewLog: false,
            hostLog: false,
            permissionInspection: false,
        } as never,
        state: { approvalMode: "auto" } as never,
        onReplicaDiverged: () => {},
        sandbox,
    });
    expect(remote.boundary.readSandboxInspection?.()).toEqual(
        sandbox.inspection(),
    );
});

test("@core a wrap that cannot be spawned is released at once", async () => {
    const sandbox = new FakeSandbox({ argv: ["/nonexistent/vera-sandbox-wrapper"] });
    const registry = new ManagedProcessRegistry({ sandbox });
    let thrown: unknown;
    try {
        await registry.scope("spawn-failure").run({
            command: "echo treasure",
            cwd: workspace(),
            env: { ...process.env, PATH: process.env.PATH ?? "" },
            interactive: false,
            sandbox: { sessionId: "spawn-failure", toolCallId: "call-1" },
        });
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // No child ran, so the wrap is released here rather than at shutdown.
    expect(sandbox.ended).toEqual(["cmd-1"]);
});
