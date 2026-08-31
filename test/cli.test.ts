import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
    applyProfileFlag,
    applyRescueCommand,
    namedProfileFlag,
    runCli,
    runCliMain,
} from "../clients/cli/main.ts";
import { VeraProfileError } from "../src/profile-paths.ts";
import type { RegisteredAgentSummary } from "../src/host/agent-registry.ts";
import { VeraConfigError } from "../src/config.ts";
import type { VeraDoctorReport } from "../clients/process-doctor.ts";
import {
    HostProtocolMismatchError,
    HostUnresponsiveError,
} from "../src/host/lockfile.ts";
import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";
import { SupervisionUnsupportedError } from "../src/host/supervision.ts";
import { formatVeraVersion, readStampedRelease } from "../src/release/stamp.ts";
import { renderCliHelp } from "../clients/cli/help.ts";
import { loadHelpCorpus } from "../clients/cli/help-corpus.ts";

test("vera help and version are available without starting a client", async () => {
    let output = "";
    let started = false;
    const dependencies = {
        runTui: async () => {
            started = true;
        },
        stdout: { write: (text: string) => output += text },
        version: "vera 0.0.4 (vera-abc1234)",
    };

    expect(await runCli(["--help"], dependencies)).toBe(0);
    expect(output).toContain("Vera coding agent");
    expect(output).toContain("vera attach <agent-id>");
    expect(output).toContain("vera resume <session-id|path>");
    expect(output).toContain("vera export <session-path>");
    expect(output).toContain("vera inspect <session-path>");
    expect(output).toContain("vera configure");
    expect(output).toContain("vera doctor");
    expect(output).toContain("vera prune");
    expect(output).toContain("vera models refresh");
    expect(output).toContain("vera shortlist list");
    expect(output).toContain("vera shortlist add <provider/model>");
    expect(output).toContain("vera shortlist remove <name|id>");
    expect(output).toContain("vera login");
    expect(output).toContain("vera stdio");
    expect(output).toContain("-v, --version");

    output = "";
    expect(await runCli(["--version"], dependencies)).toBe(0);
    expect(output).toBe("vera 0.0.4 (vera-abc1234)\n");
    expect(started).toBe(false);
});

test("vera configure opens the config editor without starting a client", async () => {
    let opened = false;
    let started = false;

    expect(await runCli(["configure"], {
        openConfigure: async () => {
            opened = true;
        },
        runTui: async () => {
            started = true;
        },
    })).toBe(0);
    expect(opened).toBe(true);
    expect(started).toBe(false);
});

test("schedule CLI carries cron, timezone, target, and inert payload", async () => {
    const calls: unknown[] = [];
    let output = "";
    expect(await runCli([
        "schedule", "add", "daily-review",
        "--cron", "0 9 * * *",
        "--timezone", "America/New_York",
        "--to", "peer",
        "--text", "Review open work",
    ], {
        scheduleOperation: async (operation) => {
            calls.push(operation);
            return { schedule_id: "daily-review", enabled: true };
        },
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(calls).toEqual([{
        action: "add",
        id: "daily-review",
        cron: "0 9 * * *",
        timezone: "America/New_York",
        address: "peer",
        payload: { text: "Review open work" },
    }]);
    expect(JSON.parse(output)).toEqual({
        schedule_id: "daily-review",
        enabled: true,
    });
});

test("schedule CLI supports structured payloads and control verbs", async () => {
    const calls: unknown[] = [];
    const execute = async (operation: unknown) => {
        calls.push(operation);
        return {};
    };
    expect(await runCli([
        "schedule", "add", "structured",
        "--cron", "*/15 * * * *",
        "--to", "peer",
        "--payload", '{"operation":"review","limit":3}',
    ], { scheduleOperation: execute, stdout: { write() {} } })).toBe(0);
    for (const args of [
        ["list"], ["show", "daily"], ["pause", "daily"],
        ["resume", "daily"], ["run", "daily"], ["remove", "daily"],
    ]) {
        expect(await runCli(["schedule", ...args], {
            scheduleOperation: execute,
            stdout: { write() {} },
        })).toBe(0);
    }
    expect(calls).toEqual([
        {
            action: "add",
            id: "structured",
            cron: "*/15 * * * *",
            timezone: "UTC",
            address: "peer",
            payload: { operation: "review", limit: 3 },
        },
        { action: "list" },
        { action: "show", id: "daily" },
        { action: "pause", id: "daily" },
        { action: "resume", id: "daily" },
        { action: "run", id: "daily" },
        { action: "remove", id: "daily" },
    ]);
});

test("vera inspect writes the latest model request", async () => {
    let sessionPath = "";
    let output = "";

    expect(await runCli(["inspect", "/sessions/one.jsonl"], {
        inspectModelRequest: async (path) => {
            sessionPath = path;
            return "{\"format_version\":1}\n";
        },
        stdout: { write: (text) => output += text },
    })).toBe(0);

    expect(sessionPath).toBe("/sessions/one.jsonl");
    expect(output).toBe("{\"format_version\":1}\n");
});

test("vera export writes Markdown by default and accepts JSON", async () => {
    const calls: Array<{ path: string; format: string }> = [];
    let output = "";
    const exportSession = async (path: string, format: "markdown" | "json") => {
        calls.push({ path, format });
        return format === "json" ? "{\"ok\":true}\n" : "# Chat\n";
    };

    expect(await runCli(["export", "/sessions/one.jsonl"], {
        exportSession,
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(await runCli([
        "export",
        "/sessions/two.jsonl",
        "--format",
        "json",
    ], {
        exportSession,
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(calls).toEqual([
        { path: "/sessions/one.jsonl", format: "markdown" },
        { path: "/sessions/two.jsonl", format: "json" },
    ]);
    expect(output).toBe("# Chat\n{\"ok\":true}\n");
});

test("the package bin runs help from outside the checkout", () => {
    const packagePath = resolve(import.meta.dir, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
        readonly bin?: { readonly vera?: string };
    };
    const bin = packageJson.bin?.vera;
    expect(bin).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "vera-bin-smoke-"));

    try {
        const executable = resolve(dirname(packagePath), bin!);
        const result = Bun.spawnSync(
            [executable, "--help"],
            { cwd: directory, stdout: "pipe", stderr: "pipe" },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("vera attach <agent-id>");
        expect(result.stdout.toString()).not.toContain("vera send");
        expect(result.stderr.toString()).toBe("");

        const version = Bun.spawnSync(
            [executable, "--version"],
            {
                cwd: directory,
                env: {
                    ...process.env,
                    PATH: process.env.PATH ?? "",
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString()).toBe(
            `${formatVeraVersion(readStampedRelease())}\n`,
        );
        expect(version.stderr.toString()).toBe("");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("vera ls names sessions and says when they were last active", async () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "agent-a",
            name: "vera:a3f1",
            workspace: process.cwd(),
            session_path: "/sessions/agent-a.jsonl",
            kind: "interactive",
            status: "working",
            live: true,
            title: "pool CLI verify pass",
            updated_at: new Date(Date.now() - 4 * 60_000).toISOString(),
        },
    ];
    let output = "";

    const exitCode = await runCli(["ls"], {
        listAgents: async () => agents,
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("KIND         STATUS   AGENT");
    expect(output).toContain("vera:a3f1");
    expect(output).toContain("pool CLI verify pass");
    expect(output).toContain("4m ago");
    // The session path was the widest column and only ever repeated the agent.
    expect(output).not.toContain("/sessions/agent-a.jsonl");
    // Every row would carry the same workspace, so it is not worth a column.
    expect(output).not.toContain("WORKSPACE");
});

test("vera ls shows only this workspace until asked for all of them", async () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "agent-here",
            workspace: process.cwd(),
            session_path: "/sessions/agent-here.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
        },
        {
            id: "agent-elsewhere",
            workspace: "/work/beta",
            session_path: "/sessions/agent-elsewhere.jsonl",
            kind: "background",
            status: "completed",
            live: false,
        },
    ];
    let scoped = "";
    let all = "";

    expect(await runCli(["ls"], {
        listAgents: async () => agents,
        stdout: { write: (text) => scoped += text },
    })).toBe(0);
    expect(await runCli(["ls", "--all"], {
        listAgents: async () => agents,
        stdout: { write: (text) => all += text },
    })).toBe(0);

    expect(scoped).toContain("agent-here");
    expect(scoped).not.toContain("agent-elsewhere");
    expect(all).toContain("agent-here");
    expect(all).toContain("agent-elsewhere");
    expect(all).toContain("WORKSPACE");
    expect(all).toContain("/work/beta");
});

test("an empty scoped list points at the flag that widens it", async () => {
    let output = "";

    expect(await runCli(["ls"], {
        listAgents: async () => [],
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(output).toContain("--all");
});

test("vera ls calls a resident but unheld session stopped, not idle", async () => {
    let output = "";

    const exitCode = await runCli(["ls"], {
        listAgents: async () => [{
            id: "agent-c",
            workspace: process.cwd(),
            session_path: "/sessions/agent-c.jsonl",
            kind: "interactive" as const,
            status: "idle" as const,
            live: false,
        }],
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("stopped");
    expect(output).not.toContain("idle");
});

test("vera stdio selects create, attach, and resume targets", async () => {
    const targets: unknown[] = [];
    const runStdio = async (target: unknown): Promise<void> => {
        targets.push(target);
    };

    expect(await runCli(["stdio"], { runStdio })).toBe(0);
    expect(await runCli(["stdio", "--attach", "agent-1"], { runStdio })).toBe(0);
    expect(await runCli(["stdio", "--resume", "session-1"], { runStdio })).toBe(0);

    expect(targets).toEqual([
        { type: "create" },
        { type: "attach", agentId: "agent-1" },
        { type: "resume", selector: "session-1" },
    ]);
});

test("vera doctor renders process health and exits nonzero for a finding", async () => {
    let output = "";
    const exitCode = await runCli(["doctor"], {
        doctor: async () => ({
            healthy: false,
            currentHostPid: 200,
            currentHostMissing: false,
            highCpuPercent: 50,
            processes: [{
                pid: 201,
                ppid: 1,
                pgid: 201,
                elapsed: "03-00:00:00",
                cpuPercent: 99,
                startedAt: "Mon Aug 10 12:34:56 2026",
                command: "bun /work/vera/clients/host/main.ts",
                kind: "host",
                currentHost: false,
                knownProfileHost: false,
                sustainedHighCpu: true,
                stray: false,
            }],
        }),
        providerDoctor: async () => ({
            providers: [],
            networkChecked: false,
        }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("Vera doctor");
    expect(output).toContain("PID 201");
    expect(output).toContain("Providers");
});

function strayReport(): VeraDoctorReport {
    return {
        healthy: false,
        currentHostMissing: false,
        highCpuPercent: 50,
        processes: [{
            pid: 401,
            ppid: 1,
            pgid: 401,
            elapsed: "00:05:00",
            cpuPercent: 0,
            startedAt: "Mon Aug 10 12:34:56 2026",
            command: "bun src/host/worker/entry.ts",
            kind: "worker",
            currentHost: false,
            knownProfileHost: false,
            sustainedHighCpu: false,
            stray: true,
        }],
    };
}

test("vera doctor stops stray processes once the caller confirms", async () => {
    let output = "";
    let asked: readonly unknown[] | undefined;
    let stoppedWith: readonly unknown[] | undefined;
    const exitCode = await runCli(["doctor"], {
        doctor: async () => strayReport(),
        providerDoctor: async () => ({ providers: [], networkChecked: false }),
        confirmStopStrayProcesses: async (strays) => {
            asked = strays;
            return true;
        },
        stopStrayProcesses: async (strays) => {
            stoppedWith = strays;
            return strays.length;
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(asked?.length).toBe(1);
    expect(stoppedWith?.length).toBe(1);
    expect(output).toContain("Stopped 1 stray process.");
});

test("vera doctor leaves stray processes running when the caller declines", async () => {
    let output = "";
    let stopCalled = false;
    const exitCode = await runCli(["doctor"], {
        doctor: async () => strayReport(),
        providerDoctor: async () => ({ providers: [], networkChecked: false }),
        confirmStopStrayProcesses: async () => false,
        stopStrayProcesses: async () => {
            stopCalled = true;
            return 0;
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(stopCalled).toBe(false);
    expect(output).toContain("Left stray processes and leftover tmux sockets in place.");
});

test("vera doctor --yes stops stray processes without asking", async () => {
    let output = "";
    let confirmCalled = false;
    const exitCode = await runCli(["doctor", "--yes"], {
        doctor: async () => strayReport(),
        providerDoctor: async () => ({ providers: [], networkChecked: false }),
        confirmStopStrayProcesses: async () => {
            confirmCalled = true;
            return false;
        },
        stopStrayProcesses: async (strays) => strays.length,
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(confirmCalled).toBe(false);
    expect(output).toContain("Stopped 1 stray process.");
});

test("vera doctor --yes removes leftover tmux sockets without asking", async () => {
    let output = "";
    let confirmCalled = false;
    let sweptNames: readonly string[] | undefined;
    const sockets = leftoverTmuxSocketReport();
    const exitCode = await runCli(["doctor", "--yes"], {
        doctor: async () => ({
            healthy: true,
            currentHostMissing: false,
            highCpuPercent: 50,
            processes: [],
        }),
        tmuxSockets: async () => sockets,
        providerDoctor: async () => ({ providers: [], networkChecked: false }),
        confirmStopStrayProcesses: async () => {
            confirmCalled = true;
            return false;
        },
        sweepTmuxSockets: async (report) => {
            sweptNames = report.sockets
                .filter((socket) => socket.stray)
                .map((socket) => socket.name);
            return { killedServers: 0, unlinkedFiles: 1 };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(confirmCalled).toBe(false);
    expect(sweptNames).toEqual(["vera-work-tab-1"]);
    expect(output).toContain("1 leftover Vera socket");
    expect(output).not.toContain("Leftover live Vera servers");
    expect(output).toContain("removed 1 leftover tmux socket.");
});

function leftoverTmuxSocketReport() {
    return {
        healthy: false,
        directory: "/tmp/tmux-501",
        sockets: [
            { name: "default", live: false, veraOwned: false, stray: false },
            { name: "otps", live: true, veraOwned: true, stray: false },
            { name: "pimem", live: true, veraOwned: false, stray: false },
            { name: "vera-work-tab-1", live: false, veraOwned: true, stray: true },
        ],
    };
}

test("vera prune lists posted processes and stops only the ones confirmed", async () => {
    let output = "";
    const asked: number[] = [];
    const stopped: number[] = [];
    const posted = [
        {
            schema_version: 1 as const,
            pid: 501,
            kind: "host" as const,
            started_at: "2026-08-29T12:00:00.000Z",
            runtime_dir: "/tmp/vera-daily",
        },
        {
            schema_version: 1 as const,
            pid: 502,
            kind: "tui" as const,
            started_at: "2026-08-29T12:00:01.000Z",
            runtime_dir: "/tmp/vera-work",
        },
    ];
    const exitCode = await runCli(["prune"], {
        prune: async () => posted,
        confirmPruneProcess: async (record) => {
            asked.push(record.pid);
            return record.pid === 502;
        },
        stopPruneProcess: async (pid) => {
            stopped.push(pid);
            return 1;
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(asked).toEqual([501, 502]);
    expect(stopped).toEqual([502]);
    expect(output).toContain("Vera prune");
    expect(output).toContain("PID 501");
    expect(output).toContain("PID 502");
    expect(output).toContain("/tmp/vera-work");
    expect(output).toContain("Stopped 1 process.");
});

test("vera prune leaves every listed process running when each stop is declined", async () => {
    let output = "";
    let stopCalled = false;
    const exitCode = await runCli(["prune"], {
        prune: async () => [{
            schema_version: 1,
            pid: 601,
            kind: "worker",
            started_at: "2026-08-29T12:00:00.000Z",
            runtime_dir: "/tmp/vera-daily",
        }],
        confirmPruneProcess: async () => false,
        stopPruneProcess: async () => {
            stopCalled = true;
            return 0;
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(stopCalled).toBe(false);
    expect(output).toContain("Left every listed process running.");
});

test("vera --yes prune still asks about each process", async () => {
    let confirmCalled = false;
    let stopCalled = false;
    const exitCode = await runCli(["--yes", "prune"], {
        prune: async () => [{
            schema_version: 1,
            pid: 701,
            kind: "host",
            started_at: "2026-08-29T12:00:00.000Z",
            runtime_dir: "/tmp/vera-daily",
        }],
        confirmPruneProcess: async () => {
            confirmCalled = true;
            return false;
        },
        stopPruneProcess: async () => {
            stopCalled = true;
            return 0;
        },
        stdout: { write() {} },
    });

    expect(exitCode).toBe(0);
    expect(confirmCalled).toBe(true);
    expect(stopCalled).toBe(false);
});

test("vera prune with extra arguments prints usage", async () => {
    let error = "";
    expect(await runCli(["prune", "--yes"], {
        stderr: { write: (text) => error += text },
        stdout: { write() {} },
    })).toBe(1);
    expect(error).toContain("vera --help");
});

test("vera prune with an empty board does not ask", async () => {
    let output = "";
    let confirmCalled = false;
    const exitCode = await runCli(["prune"], {
        prune: async () => [],
        confirmPruneProcess: async () => {
            confirmCalled = true;
            return true;
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(confirmCalled).toBe(false);
    expect(output).toContain("No Vera processes listed.");
});

test("vera doctor --check-providers asks for the network probe", async () => {
    let output = "";
    let requested: boolean | undefined;
    const exitCode = await runCli(["doctor", "--check-providers"], {
        doctor: async () => ({
            healthy: true,
            currentHostPid: 200,
            currentHostMissing: false,
            highCpuPercent: 50,
            processes: [],
        }),
        providerDoctor: async (options) => {
            requested = options.checkNetwork;
            return {
                providers: [{
                    id: "my-endpoint",
                    custom: true,
                    connected: true,
                    credentialSource: "env",
                    envVar: "MY_ENDPOINT_KEY",
                    envVarPresent: true,
                    endpoint: {
                        baseUrl: "https://llm.example.test/v1",
                        protocol: "openai-chat",
                    },
                    probe: {
                        reachability: "rejected",
                        url: "https://llm.example.test/v1/models",
                        status: 401,
                    },
                    captures: [],
                }],
                networkChecked: true,
            };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(requested).toBe(true);
    expect(output).toContain("which rejected the credential (HTTP 401)");
    expect(output).toContain("Credential: from MY_ENDPOINT_KEY");
});

test("vera abort requests cancellation through a resident agent", async () => {
    const aborted: string[] = [];
    let output = "";

    const exitCode = await runCli(["abort", "agent-1"], {
        abortAgent: async (agentId) => {
            aborted.push(agentId);
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(aborted).toEqual(["agent-1"]);
    expect(output).toBe("Abort requested for agent-1.\n");
});

test("vera close ends a live agent and names how to get the session back", async () => {
    const closed: string[] = [];
    let output = "";

    const exitCode = await runCli(["close", "agent-1"], {
        closeAgent: async (agentId) => {
            closed.push(agentId);
            return { status: "closed", sessionRetained: true };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["agent-1"]);
    expect(output).toBe(
        "Closed agent-1. Its session is kept; "
        + "resume it with 'vera resume agent-1'.\n",
    );
});

test("vera close reports a rejection as an error with a next action", async () => {
    let error = "";

    const exitCode = await runCli(["close", "ghost"], {
        closeAgent: async () => ({
            status: "rejected",
            reason: "not_found",
        }),
        stderr: { write: (text) => error += text },
    });

    expect(exitCode).toBe(1);
    expect(error).toContain("Could not close ghost");
    expect(error).toContain("vera ls --all");
});

test("vera close with no agent id names the id and how to find one", async () => {
    let error = "";

    const exitCode = await runCli(["close"], {
        stderr: { write: (text) => error += text },
    });

    expect(exitCode).toBe(1);
    expect(error).toContain("close needs the id of a live agent");
    expect(error).toContain("vera ls");
    expect(error).toContain("vera close <agent-id>");
});

test("vera abort with no agent id names the id and how to find one", async () => {
    let error = "";

    const exitCode = await runCli(["abort"], {
        stderr: { write: (text) => error += text },
    });

    expect(exitCode).toBe(1);
    expect(error).toContain("abort needs the id of a live agent");
    expect(error).toContain("vera abort <agent-id>");
});

test("vera close does not offer a resume for a session it deleted", async () => {
    let output = "";

    const exitCode = await runCli(["close", "temp-1"], {
        closeAgent: async () => ({ status: "closed", sessionRetained: false }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("its session is gone");
    expect(output).not.toContain("vera resume");
});

test("vera close accepts the identifier vera ls prints", async () => {
    const closed: string[] = [];
    let output = "";

    const exitCode = await runCli(["close", "amber-ember:333d"], {
        listAgents: async () => [closeableAgent("uuid-aaaa-1111", "amber-ember:333d")],
        closeAgent: async (agentId) => {
            closed.push(agentId);
            return { status: "closed", sessionRetained: true };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["uuid-aaaa-1111"]);
    expect(output).toContain("Closed amber-ember:333d.");
    expect(output).toContain("vera resume uuid-aaaa-1111");
});

test("vera close accepts an unambiguous id prefix", async () => {
    const closed: string[] = [];

    const exitCode = await runCli(["close", "uuid-aa"], {
        listAgents: async () => [
            closeableAgent("uuid-aaaa-1111", "amber-ember:333d"),
            closeableAgent("uuid-bbbb-2222", "slate-heron:9c0e"),
        ],
        closeAgent: async (agentId) => {
            closed.push(agentId);
            return { status: "closed", sessionRetained: true };
        },
        stdout: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(closed).toEqual(["uuid-aaaa-1111"]);
});

test("vera close refuses an ambiguous prefix and names the candidates", async () => {
    const closed: string[] = [];
    let error = "";

    const exitCode = await runCli(["close", "uuid-"], {
        listAgents: async () => [
            closeableAgent("uuid-aaaa-1111", "amber-ember:333d"),
            closeableAgent("uuid-bbbb-2222", "slate-heron:9c0e"),
        ],
        closeAgent: async (agentId) => {
            closed.push(agentId);
            return { status: "closed", sessionRetained: true };
        },
        stderr: { write: (text) => error += text },
    });

    expect(exitCode).toBe(1);
    // Guessing one of them is the failure this replaces.
    expect(closed).toEqual([]);
    expect(error).toContain("amber-ember:333d (uuid-aaaa-1111)");
    expect(error).toContain("slate-heron:9c0e (uuid-bbbb-2222)");
});

test("vera close still reaches not_found for an id nothing matches", async () => {
    const closed: string[] = [];
    let error = "";

    const exitCode = await runCli(["close", "ghost"], {
        listAgents: async () => [closeableAgent("uuid-aaaa-1111", "amber-ember:333d")],
        closeAgent: async (agentId) => {
            closed.push(agentId);
            return { status: "rejected", reason: "not_found" };
        },
        stderr: { write: (text) => error += text },
    });

    expect(exitCode).toBe(1);
    expect(closed).toEqual(["ghost"]);
    expect(error).toContain("no agent or session has that id");
});

function closeableAgent(id: string, name: string): RegisteredAgentSummary {
    return {
        id,
        name,
        workspace: process.cwd(),
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: "idle",
        live: true,
        updated_at: new Date().toISOString(),
    };
}

test("vera help separates stopping a turn from closing an agent", async () => {
    const help = renderCliHelp(await loadHelpCorpus());
    expect(help).toContain("vera abort <agent-id>");
    expect(help).toContain("vera close <agent-id>");
    expect(help).toContain("vera prune");
    expect(help).toContain("the agent stays live and keeps its queued prompts");
    expect(help).toContain("the session is kept and can be resumed");
});

test("vera shortlist list renders stable model rows from the pool file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-cli-pool-"));
    const previous = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = join(directory, "pool.json");
    writeFileSync(process.env.VERA_POOL_FILE, JSON.stringify({
        models: {
            "openrouter/alpha": {
                added: true,
                efforts: { high: "high", low: "low", off: null },
            },
            "openrouter/learned-only": {
                learned: { probe: { ok: false, seen: "2026-08-07" } },
            },
            "cerebras/beta": { added: true },
        },
    }));
    let output = "";

    try {
        const exitCode = await runCli(["shortlist", "list"], {
            stdout: { write: (text) => output += text },
        });

        expect(exitCode).toBe(0);
        expect(output).toBe(
            "openrouter/alpha\topenrouter\tefforts=low,high\n"
            + "cerebras/beta\tcerebras\tefforts=-\n",
        );
    } finally {
        if (previous === undefined) {
            delete process.env.VERA_POOL_FILE;
        } else {
            process.env.VERA_POOL_FILE = previous;
        }
        rmSync(directory, { recursive: true, force: true });
    }
});

test("vera shortlist add uses pool admission and remove resolves pool refs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-cli-pool-"));
    const previous = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = join(directory, "pool.json");
    let output = "";

    try {
        expect(await runCli(["shortlist", "add", "openrouter/fresh"], {
            stdout: { write: (text) => output += text },
        })).toBe(0);
        expect(JSON.parse(
            readFileSync(process.env.VERA_POOL_FILE, "utf8"),
        )).toMatchObject({
            models: {
                "openrouter/fresh": { added: true },
            },
        });

        writeFileSync(process.env.VERA_POOL_FILE, JSON.stringify({
            models: {
                "openrouter/fresh": { added: true, name: "fresh" },
            },
        }));
        expect(await runCli(["shortlist", "remove", "fresh"], {
            stdout: { write: (text) => output += text },
        })).toBe(0);
        expect(JSON.parse(
            readFileSync(process.env.VERA_POOL_FILE, "utf8"),
        ).models).toEqual({});
        expect(output).toContain(
            "openrouter/fresh pinned to your shortlist (unverified).",
        );
        expect(output).toContain("fresh removed from your shortlist.");
    } finally {
        if (previous === undefined) {
            delete process.env.VERA_POOL_FILE;
        } else {
            process.env.VERA_POOL_FILE = previous;
        }
        rmSync(directory, { recursive: true, force: true });
    }
});

test("vera shortlist add --verify asks for verification and reports probe steps", async () => {
    let received: { verify?: boolean } | undefined;
    let output = "";
    let errors = "";

    expect(await runCli(["shortlist", "add", "openrouter/fresh", "--verify"], {
        stdout: { write: (text) => output += text },
        stderr: { write: (text) => errors += text },
        addPoolModel: async (_workspace, _ref, options) => {
            received = options;
            options.onStep?.({
                step: "probe",
                label: "one turn",
                status: "passed",
            });
            return { verdict: "added" };
        },
    })).toBe(0);

    expect(received?.verify).toBe(true);
    expect(output).toContain("openrouter/fresh pinned to your shortlist (verified).");
    expect(errors).toContain("passed");
    expect(errors).toContain("one turn");
});

test("vera shortlist add reports a refused verification as a nonzero exit", async () => {
    let errors = "";

    expect(await runCli(["shortlist", "add", "openrouter/fresh", "--verify"], {
        stderr: { write: (text) => errors += text },
        addPoolModel: async () => ({
            verdict: "incompatible",
            reason: "no tool calls",
        }),
    })).toBe(1);

    expect(errors).toContain("was not pinned (incompatible)");
    expect(errors).toContain("no tool calls");
});

test("vera shortlist add rejects an unknown flag", async () => {
    expect(await runCli(["shortlist", "add", "openrouter/fresh", "--force"], {
        stderr: { write: () => {} },
    })).toBe(1);
});

test("vera interactive commands select home, continue, attach, and resume targets", async () => {
    const targets: unknown[] = [];
    const runTui = async (target: unknown): Promise<void> => {
        targets.push(target);
    };

    expect(await runCli([], { runTui })).toBe(0);
    expect(await runCli(["-c"], { runTui })).toBe(0);
    expect(await runCli(["attach", "agent-1"], { runTui })).toBe(0);
    expect(await runCli(["resume", "/sessions/one.jsonl"], { runTui })).toBe(0);
    expect(targets).toEqual([
        { type: "home", workspace: process.cwd() },
        { type: "continue" },
        { type: "attach", agentId: "agent-1" },
        { type: "resume", sessionPath: "/sessions/one.jsonl" },
    ]);
});

test("vera startup profiles reach interactive and print sessions", async () => {
    const targets: unknown[] = [];
    const requests: unknown[] = [];
    const runOnce = async (request: unknown) => {
        requests.push(request);
        return {
            agentId: "bounded",
            sessionPath: "/sessions/bounded.jsonl",
            text: "done",
            outcome: "completed" as const,
            notes: [],
        };
    };

    expect(await runCli(["--bare"], {
        runTui: async (target) => {
            targets.push(target);
        },
    })).toBe(0);
    expect(await runCli(["-p", "measure", "--prompt-only"], {
        runOnce: runOnce as never,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
    })).toBe(0);

    expect(targets).toEqual([{
        type: "create",
        workspace: process.cwd(),
        startupProfile: "bare",
    }]);
    expect(requests).toEqual([{
        workspace: process.cwd(),
        prompt: "measure",
        startupProfile: "prompt_only",
    }]);
});

test("vera --yes preapproves a busy resident-host restart", async () => {
    let approved = false;
    const exitCode = await runCli(["--yes"], {
        runTui: async (_target, options) => {
            approved = await options!.confirmBusyUpgrade!(new Error("old host"));
        },
    });

    expect(exitCode).toBe(0);
    expect(approved).toBe(true);
});

test("vera login is reserved for a Vera account and connects no provider", async () => {
    // It used to run the Codex flow, which made a bare `login` mean whichever
    // provider happened to be built first. Providers are connected in the model
    // pane now, so this says what it is and does nothing.
    let output = "";

    const exitCode = await runCli(["login"], {
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Vera accounts are not available yet.");
    expect(output).toContain("ctrl+e");
});

test("vera reports host upgrades without a runtime stack trace", async () => {
    let errorOutput = "";
    const exitCode = await runCliMain([], {
        runTui: () => Promise.reject(new HostProtocolMismatchError(49372, 1)),
        stderr: { write: (text) => errorOutput += text },
    });

    expect(exitCode).toBe(1);
    expect(errorOutput).toBe(
        "Vera host upgrade required: Resident Vera host PID 49372 uses protocol 1; "
        + `stop it and relaunch Vera to use protocol ${HOST_PROTOCOL_VERSION}.\n`
        + "Close the older Vera client and retry, or run 'vera host stop'.\n",
    );
    expect(errorOutput).not.toContain("clients/tui/main.ts");
    expect(errorOutput).not.toContain("HostProtocolMismatchError:");
});

test("vera host stop confirms the explicit resident-host shutdown", async () => {
    let output = "";
    let stopped = false;
    const exitCode = await runCli(["host", "stop"], {
        confirmHostStop: () => true,
        stopHost: async () => {
            stopped = true;
            return { pid: 51639, endedBy: "sigterm" };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(stopped).toBe(true);
    expect(output).toBe("Stopped resident Vera host PID 51639.\n");
});

test("vera host stop leaves the host running when confirmation is declined", async () => {
    let output = "";
    let stopped = false;

    const exitCode = await runCli(["host", "stop"], {
        confirmHostStop: () => false,
        stopHost: async () => {
            stopped = true;
            return { pid: 51639, endedBy: "sigterm" };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(stopped).toBe(false);
    expect(output).toBe("Resident Vera host was not stopped.\n");
});

test("vera host stop --yes skips confirmation", async () => {
    let confirmed = false;
    let stopped = false;

    const exitCode = await runCli(["host", "stop", "--yes"], {
        confirmHostStop: () => {
            confirmed = true;
            return false;
        },
        stopHost: async () => {
            stopped = true;
            return { pid: 51639, endedBy: "sigterm" };
        },
        stdout: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(confirmed).toBe(false);
    expect(stopped).toBe(true);
});

test("vera host stop --force uses the handshake-free stop", async () => {
    let output = "";
    let forced = false;
    const exitCode = await runCli(["host", "stop", "--force", "--yes"], {
        forceStopHost: async () => {
            forced = true;
            return { pid: 51639, endedBy: "sigkill" };
        },
        stopHost: async () => {
            throw new Error("the graceful stop must not run under --force");
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(forced).toBe(true);
    expect(output).toBe(
        "Stopped resident Vera host PID 51639 (killed after it ignored SIGTERM).\n",
    );
});

test("vera host stop --force still asks for confirmation", async () => {
    let output = "";
    const exitCode = await runCli(["host", "stop", "--force"], {
        confirmHostStop: () => false,
        forceStopHost: async () => {
            throw new Error("declined stop must not force anything");
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toBe("Resident Vera host was not stopped.\n");
});

test("vera host stop --yes does not print Stopped if the pid is still there", async () => {
    let output = "";
    const exitCode = await runCli(["host", "stop", "--yes"], {
        stopHost: async () => ({ pid: 51639, endedBy: "survived" }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(1);
    expect(output).toBe(
        "Resident Vera host PID 51639 is still running. "
            + "Run 'vera host stop --force' to kill it.\n",
    );
    expect(output).not.toContain("Stopped");
});

test("vera rescue runs the TUI under the rescue profile", async () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyRescueCommand(["rescue"], env)).toEqual([]);
    expect(env.VERA_PROFILE).toBe("rescue");
    expect(applyRescueCommand(["host", "stop"], env)).toEqual(["host", "stop"]);
});

test("vera names the recovery commands for an unresponsive host", async () => {
    let errorOutput = "";
    const exitCode = await runCliMain([], {
        runTui: () => Promise.reject(new HostUnresponsiveError(51639)),
        stderr: { write: (text) => errorOutput += text },
    });

    expect(exitCode).toBe(1);
    expect(errorOutput).toBe(
        "Resident Vera host PID 51639 is running but not responding.\n"
        + "Run 'vera host stop --force' to kill it.\n"
        + "For a working Vera while it stays wedged, run 'vera rescue', then"
        + " stop this one with"
        + " 'vera host stop --force --profile default'.\n",
    );
});

test("vera rescue reads past the global yes flag", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyRescueCommand(["--yes", "rescue"], env)).toEqual(["--yes"]);
    expect(env.VERA_PROFILE).toBe("rescue");
});

test("vera rescue refuses to also take an explicit profile", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyRescueCommand(["rescue"], env, "dogfood")).toThrow(
        VeraProfileError,
    );
    expect(env.VERA_PROFILE).toBeUndefined();
});

test("host stop under a named profile targets that profile's host", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(namedProfileFlag(["host", "stop", "--force", "--profile", "default"]))
        .toBe("default");
    expect(namedProfileFlag(["host", "stop", "--force"])).toBeUndefined();
    expect(applyProfileFlag(
        ["host", "stop", "--force", "--profile", "default"],
        env,
    )).toEqual(["host", "stop", "--force"]);
    expect(env.VERA_PROFILE).toBe("default");
});

test("vera reports a damaged config without a runtime stack trace", async () => {
    let errorOutput = "";
    const exitCode = await runCliMain([], {
        runTui: () =>
            Promise.reject(
                new VeraConfigError(
                    "/home/u/.vera/config.json",
                    "it is not valid JSON (Unexpected end of JSON input)",
                ),
            ),
        stderr: { write: (text) => errorOutput += text },
    });

    expect(exitCode).toBe(1);
    expect(errorOutput).toBe(
        "Vera config at /home/u/.vera/config.json could not be read: it is not"
        + " valid JSON (Unexpected end of JSON input)\n"
        + "Fix or remove /home/u/.vera/config.json and run Vera again.\n",
    );
    expect(errorOutput).not.toContain("    at ");
});

test("vera -p prints the final reply and exits zero", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let output = "";
    let errors = "";

    expect(await runCli(["-p", "explain this repo"], {
        runOnce: async (request) => {
            requests.push({ ...request });
            return {
                agentId: "bounded",
                sessionPath: "/sessions/bounded.jsonl",
                text: "It is a coding agent.",
                outcome: "completed" as const,
                notes: [],
            };
        },
        stdout: { write: (text) => output += text },
        stderr: { write: (text) => errors += text },
    })).toBe(0);

    expect(requests).toMatchObject([{
        workspace: process.cwd(),
        prompt: "explain this repo",
    }]);
    expect(requests[0]?.approvalMode).toBeUndefined();
    expect(output).toBe("It is a coding agent.\n");
    expect(errors).toBe("");
});

test("vera -p passes an approval mode through and fails on a turn error", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let output = "";
    let errors = "";

    expect(await runCli(
        ["-p", "do the thing", "--permission-mode", "full_access"],
        {
            runOnce: async (request) => {
                requests.push({ ...request });
                return {
                    agentId: "bounded",
                    sessionPath: "/sessions/bounded.jsonl",
                    text: "",
                    outcome: "error" as const,
                    error: "Provider is not connected",
                    notes: ["Denied bash: a print-mode run never waits."],
                };
            },
            stdout: { write: (text) => output += text },
            stderr: { write: (text) => errors += text },
        },
    )).toBe(1);

    expect(requests[0]?.approvalMode).toBe("full_access");
    expect(output).toBe("");
    expect(errors).toContain("Denied bash");
    expect(errors).toContain("Provider is not connected");
});

test("vera -p flags compose in any order and unknown flags are refused", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let output = "";
    let errors = "";
    const dependencies = {
        runOnce: async (request: Record<string, unknown>) => {
            requests.push({ ...request });
            return {
                agentId: "bounded",
                sessionPath: "/sessions/bounded.jsonl",
                text: "ok",
                outcome: "completed" as const,
                notes: [],
            };
        },
        stdout: { write: (text: string) => output += text },
        stderr: { write: (text: string) => errors += text },
    };

    expect(await runCli(
        ["-p", "sweep", "--model", "openai/gpt-5.5", "--effort", "high"],
        dependencies,
    )).toBe(0);
    expect(await runCli(
        ["-p", "sweep", "--effort", "low", "--permission-mode", "full_access"],
        dependencies,
    )).toBe(0);
    expect(await runCli(
        [
            "-p",
            "sweep",
            "--permission-mode",
            "auto",
            "--model",
            "anthropic/claude-opus-4",
        ],
        dependencies,
    )).toBe(0);

    expect(requests).toMatchObject([
        { prompt: "sweep", model: "openai/gpt-5.5", effort: "high" },
        { prompt: "sweep", effort: "low", approvalMode: "full_access" },
        {
            prompt: "sweep",
            approvalMode: "auto",
            model: "anthropic/claude-opus-4",
        },
    ]);

    errors = "";
    expect(await runCli(["-p", "sweep", "--temperature", "0"], dependencies))
        .toBe(1);
    expect(await runCli(["-p", "sweep", "--model"], dependencies)).toBe(1);
    expect(await runCli(["-p"], dependencies)).toBe(1);
    expect(errors).toContain("vera --help");
    expect(requests).toHaveLength(3);
});

test("vera models refresh reports each provider and names an uncredentialed failure", async () => {
    let output = "";
    const exitCode = await runCli(["models", "refresh"], {
        stdout: { write: (text) => output += text },
        refreshCatalogs: async () => [
            { provider: "openrouter", models: 3 },
            { provider: "cerebras", failure: "missing_credential" },
        ],
    });

    expect(exitCode).toBe(0);
    expect(output).toBe(
        "openrouter: 3 models\ncerebras: failed (no credential)\n",
    );
});

test("vera models refresh fails when no provider could be asked", async () => {
    let output = "";
    const exitCode = await runCli(["models", "refresh"], {
        stdout: { write: (text) => output += text },
        refreshCatalogs: async () => [
            { provider: "openrouter", failure: "missing_credential" },
        ],
    });

    expect(exitCode).toBe(1);
    expect(output).toBe("openrouter: failed (no credential)\n");
});

test("vera models refresh names a stale provider while keeping its rows", async () => {
    let output = "";
    const exitCode = await runCli(["models", "refresh"], {
        stdout: { write: (text) => output += text },
        refreshCatalogs: async () => [
            {
                provider: "cerebras",
                models: 2,
                failure: "unavailable",
                keptModels: 2,
            },
        ],
    });

    expect(exitCode).toBe(1);
    expect(output).toBe(
        "cerebras: failed (provider unavailable; kept 2 cached models)\n",
    );
});

test("vera host supervise turns supervision on", async () => {
    let output = "";
    let requested: string | undefined;
    const exitCode = await runCli(["host", "supervise"], {
        superviseHost: (action) => {
            requested = action;
            return {
                action: "on",
                label: "dev.vera.host.default",
                plistPath: "/home/Library/LaunchAgents/dev.vera.host.default.plist",
                replaced: false,
            };
        },
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(requested).toBe("on");
    expect(output).toStartWith("Installed dev.vera.host.default.");
    expect(output).toContain("vera host supervise off");
});

test("vera host supervise off says what is no longer watching", async () => {
    let output = "";
    const exitCode = await runCli(["host", "supervise", "off"], {
        superviseHost: () => ({
            action: "off",
            label: "dev.vera.host.default",
            plistPath: "/plist",
            removed: true,
        }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Nothing restarts the resident host now");
});

test("vera host supervise status names the supervised host's pid", async () => {
    let output = "";
    const exitCode = await runCli(["host", "supervise", "status"], {
        superviseHost: () => ({
            action: "status",
            label: "dev.vera.host.default",
            plistPath: "/plist",
            installed: true,
            loaded: true,
            pid: 4321,
        }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("running the host as PID 4321");
});

test("vera host supervise status on a profile without it names the fix", async () => {
    let output = "";
    const exitCode = await runCli(["host", "supervise", "status"], {
        superviseHost: () => ({
            action: "status",
            label: "dev.vera.host.default",
            plistPath: "/plist",
            installed: false,
            loaded: false,
        }),
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Turn it on with 'vera host supervise'.");
});

test("supervision on an unsupported platform fails with a usable message", async () => {
    let errors = "";
    const exitCode = await runCli(["host", "supervise"], {
        superviseHost: () => {
            throw new SupervisionUnsupportedError("linux");
        },
        stdout: { write: () => undefined },
        stderr: { write: (text) => errors += text },
    });

    expect(exitCode).toBe(1);
    expect(errors).toContain("launchd, which linux does not have");
});
