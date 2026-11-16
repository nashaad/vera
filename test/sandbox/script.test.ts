import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSkillScript } from "../../src/skills/script.ts";
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

const workspace = mkdtempSync(join(tmpdir(), "vera-sandbox-script-"));

afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
});

class RecordingSandbox implements CommandSandbox, SandboxInspector {
    readonly requests: SandboxCommandRequest[] = [];

    constructor(private readonly options: { readonly argv?: readonly string[] } = {}) {}

    inspection(): SandboxInspection {
        return {
            enabled: true,
            status: "active",
            network: "open",
            allowedDomains: [],
        };
    }

    prepare(request: SandboxCommandRequest): Promise<SandboxPreparation> {
        this.requests.push(request);
        return Promise.resolve({
            prepared: {
                argv: this.options.argv ?? ["/bin/sh", "-c", "echo script ran"],
                env: request.env,
                commandId: `cmd-${this.requests.length}`,
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                command: request.command,
                violationsBefore: 0,
            },
        });
    }

    settle(): Promise<SandboxSettledCommand> {
        return Promise.resolve({ suffix: "", violations: [] });
    }

    settleSync(): SandboxSettledCommand {
        return { suffix: "", violations: [] };
    }

    finishUnwrapped(_unwrapped: SandboxUnwrappedCommand): void {}

    release(_prepared: SandboxPreparedCommand): void {}

    readonly ended: SandboxPreparedCommand[] = [];

    commandEnded(prepared: SandboxPreparedCommand): void {
        this.ended.push(prepared);
    }
}

test("@core a skill script with no identity is still wrapped and logged under a stand-in", async () => {
    const sandbox = new RecordingSandbox();
    const scriptPath = "/skills/one/show.sh";
    const result = await runSkillScript({
        scriptPath,
        args: [],
        workspace,
        skillDirectory: "/skills/one",
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        sandbox,
    });
    expect(sandbox.requests).toHaveLength(1);
    const request = sandbox.requests[0]!;
    expect(request.sessionId).toStartWith("skill-script-");
    expect(request.toolCallId).toBe(scriptPath);
    expect(request.workspace).toBe(workspace);
    expect(request.command).toBe(scriptPath);
    expect(request.env).toEqual({
        VERA_WORKSPACE: workspace,
        VERA_SKILL_DIR: "/skills/one",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
        ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
        ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    });
    expect(result.kind).toBe("output");
    if (result.kind !== "output") return;
    expect(result.output).toContain("script ran");
    expect(sandbox.ended).toHaveLength(1);
    expect(sandbox.ended[0]?.commandId).toBe("cmd-1");
});

test("@core a skill script keeps the identity it was given", async () => {
    const sandbox = new RecordingSandbox();
    await runSkillScript({
        scriptPath: join("/skills/one", "show.sh"),
        args: ["--loot"],
        workspace,
        skillDirectory: "/skills/one",
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        sandbox,
        identity: {
            sessionId: "session-1",
            toolCallId: "call-1",
            approvalMode: "auto",
        },
    });
    expect(sandbox.requests[0]).toMatchObject({
        sessionId: "session-1",
        toolCallId: "call-1",
        approvalMode: "auto",
        command: "/skills/one/show.sh --loot",
    });
});

test("@core a skill script wrap that cannot be spawned is released at once", async () => {
    const sandbox = new RecordingSandbox({ argv: ["/nonexistent/vera-script-wrapper"] });
    let thrown: unknown;
    try {
        await runSkillScript({
            scriptPath: "/skills/one/show.sh",
            args: [],
            workspace,
            skillDirectory: "/skills/one",
            timeoutMs: 5_000,
            signal: new AbortController().signal,
            sandbox,
        });
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(sandbox.ended).toHaveLength(1);
});
