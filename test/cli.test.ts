import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runCli, runCliMain } from "../clients/cli/main.ts";
import type { RegisteredAgentSummary } from "../src/host/agent-registry.ts";
import { VeraConfigError } from "../src/config.ts";
import { HostProtocolMismatchError } from "../src/host/lockfile.ts";
import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.ts";

test("vera help and version are available without starting a client", async () => {
    let output = "";
    let started = false;
    const dependencies = {
        runTui: async () => {
            started = true;
        },
        stdout: { write: (text: string) => output += text },
        version: "source abc1234",
    };

    expect(await runCli(["--help"], dependencies)).toBe(0);
    expect(output).toContain("Vera coding agent");
    expect(output).toContain("vera attach <agent-id>");
    expect(output).toContain("vera resume <session-id|path>");
    expect(output).toContain("vera export <session-path>");
    expect(output).toContain("vera inspect <session-path>");
    expect(output).toContain("vera login");
    expect(output).toContain("-v, --version");

    output = "";
    expect(await runCli(["--version"], dependencies)).toBe(0);
    expect(output).toBe("vera source abc1234\n");
    expect(started).toBe(false);
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
                    HOME: directory,
                    PATH: process.env.PATH ?? "",
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(version.exitCode).toBe(0);
        expect(version.stdout.toString()).toMatch(/^vera source [0-9a-f]+(?:\+dirty)?\n$/);
        expect(version.stderr.toString()).toBe("");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("vera ls renders resident agents from the host", async () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "agent-a",
            workspace: "/work/alpha",
            session_path: "/sessions/agent-a.jsonl",
            kind: "interactive",
            status: "working",
            live: true,
        },
        {
            id: "agent-b",
            workspace: "/work/beta",
            session_path: "/sessions/agent-b.jsonl",
            kind: "background",
            status: "completed",
            live: false,
        },
    ];
    let output = "";

    const exitCode = await runCli(["ls"], {
        listAgents: async () => agents,
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("KIND         STATUS");
    expect(output).toContain("interactive  working");
    expect(output).toContain("background   completed");
    expect(output).toContain("working    /work/alpha  agent-a");
    expect(output).toContain("/work/alpha");
    expect(output).toContain("/sessions/agent-a.jsonl");
    expect(output).toContain("completed  /work/beta");
});

test("vera ls calls a resident but unheld session stopped, not idle", async () => {
    let output = "";

    const exitCode = await runCli(["ls"], {
        listAgents: async () => [{
            id: "agent-c",
            workspace: "/work/gamma",
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

test("vera rpc starts the NDJSON bridge", async () => {
    let started = false;

    const exitCode = await runCli(["rpc"], {
        runRpc: async () => {
            started = true;
        },
    });

    expect(exitCode).toBe(0);
    expect(started).toBe(true);
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

test("vera interactive commands select create, continue, attach, and resume targets", async () => {
    const targets: unknown[] = [];
    const runTui = async (target: unknown): Promise<void> => {
        targets.push(target);
    };

    expect(await runCli([], { runTui })).toBe(0);
    expect(await runCli(["-c"], { runTui })).toBe(0);
    expect(await runCli(["attach", "agent-1"], { runTui })).toBe(0);
    expect(await runCli(["resume", "/sessions/one.jsonl"], { runTui })).toBe(0);
    expect(targets).toEqual([
        { type: "create", workspace: process.cwd() },
        { type: "continue" },
        { type: "attach", agentId: "agent-1" },
        { type: "resume", sessionPath: "/sessions/one.jsonl" },
    ]);
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
            return 51639;
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
            return 51639;
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
            return 51639;
        },
        stdout: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(confirmed).toBe(false);
    expect(stopped).toBe(true);
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
