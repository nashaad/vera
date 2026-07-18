import { expect, test } from "bun:test";

import { runCli } from "../clients/cli/main.ts";
import type { RegisteredAgentSummary } from "../src/host/agent-registry.ts";

test("vera ls renders resident agents from the host", async () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "agent-a",
            workspace: "/work/alpha",
            session_path: "/sessions/agent-a.jsonl",
            status: "working",
        },
        {
            id: "agent-b",
            workspace: "/work/beta",
            session_path: "/sessions/agent-b.jsonl",
            status: "waiting",
        },
    ];
    let output = "";

    const exitCode = await runCli(["ls"], {
        listAgents: async () => agents,
        stdout: { write: (text) => output += text },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("STATUS   WORKSPACE");
    expect(output).toContain("working  /work/alpha  agent-a");
    expect(output).toContain("/work/alpha");
    expect(output).toContain("/sessions/agent-a.jsonl");
    expect(output).toContain("waiting  /work/beta");
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
