import { expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import type {
    InstanceDirectory,
    InstanceRecord,
} from "../src/instances/directory.ts";

test("vera ls renders two concurrent live instances", async () => {
    const records: InstanceRecord[] = [
        {
            schema_version: 1,
            instance_id: "instance-a",
            pid: 101,
            client: "stdio",
            workspace_path: "/work/alpha",
            started_at: "2026-07-15T14:00:00.000Z",
        },
        {
            schema_version: 1,
            instance_id: "instance-b",
            pid: 202,
            client: "tui",
            workspace_path: "/work/beta",
            started_at: "2026-07-15T14:01:00.000Z",
        },
    ];
    const instances: InstanceDirectory = {
        register: () => {
            throw new Error("not used");
        },
        list: () => records,
    };
    let output = "";

    const exitCode = await runCli(["ls"], {
        instances,
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("PID  CLIENT  STARTED");
    expect(output).toContain("101  stdio");
    expect(output).toContain("/work/alpha");
    expect(output).toContain("instance-a");
    expect(output).toContain("202  tui");
    expect(output).toContain("/work/beta");
    expect(output).toContain("instance-b");
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
