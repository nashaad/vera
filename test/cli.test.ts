import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runCli, runCliMain } from "../clients/cli/main.ts";
import type { RegisteredAgentSummary } from "../src/host/agent-registry.ts";
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
    expect(output).toContain("vera login [openai-codex]");
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
        expect(result.stdout.toString()).toContain(
            "vera send <agent-id> [--attach <path>]… <message>",
        );
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
        },
        {
            id: "agent-b",
            workspace: "/work/beta",
            session_path: "/sessions/agent-b.jsonl",
            kind: "background",
            status: "completed",
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

test("vera send runs one prompt through a resident agent", async () => {
    const sent: string[][] = [];
    let output = "";

    const exitCode = await runCli(
        ["send", "agent-1", "check", "the", "tests"],
        {
            sendPrompt: async (agentId, content) => {
                sent.push([agentId, content]);
                return "The tests pass.";
            },
            stdout: { write: (text) => output += text },
        },
    );

    expect(exitCode).toBe(0);
    expect(sent).toEqual([["agent-1", "check the tests"]]);
    expect(output).toBe("The tests pass.\n");
});

test("vera send preserves repeatable image attachments in argument order", async () => {
    let received: unknown;
    const exitCode = await runCli([
        "send",
        "agent-1",
        "--attach",
        "/tmp/first image.png",
        "compare",
        "these",
        "--attach",
        "/tmp/second.png",
    ], {
        sendPrompt: async (agentId, content, attachmentPaths) => {
            received = { agentId, content, attachmentPaths };
            return "done";
        },
        stdout: { write: () => {} },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
        agentId: "agent-1",
        content: "compare these",
        attachmentPaths: ["/tmp/first image.png", "/tmp/second.png"],
    });
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

test("vera interactive commands select create, attach, and resume targets", async () => {
    const targets: unknown[] = [];
    const runTui = async (target: unknown): Promise<void> => {
        targets.push(target);
    };

    expect(await runCli([], { runTui })).toBe(0);
    expect(await runCli(["attach", "agent-1"], { runTui })).toBe(0);
    expect(await runCli(["resume", "/sessions/one.jsonl"], { runTui })).toBe(0);
    expect(targets).toEqual([
        { type: "create", workspace: process.cwd() },
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

test("vera login runs OpenAI Codex OAuth and prints the authorization URL", async () => {
    let output = "";
    let loggedIn = false;

    const exitCode = await runCli(["login", "openai-codex"], {
        stdout: { write: (text) => output += text },
        runOpenAICodexLogin: async (onAuthorizationUrl) => {
            onAuthorizationUrl("https://auth.openai.test/authorize");
            loggedIn = true;
        },
    });

    expect(exitCode).toBe(0);
    expect(loggedIn).toBe(true);
    expect(output).toContain("https://auth.openai.test/authorize");
    expect(output).toContain("Logged in to OpenAI Codex");
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

test("vera host stop invokes the explicit resident-host shutdown", async () => {
    let output = "";
    let stopped = false;
    const exitCode = await runCli(["host", "stop"], {
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
