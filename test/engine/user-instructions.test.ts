import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleSystemPrompt } from "../../src/engine/assemble.ts";
import { contextContributionParts } from "../../src/engine/context-parts.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import {
    loadProjectInstructions,
    loadUserInstructions,
} from "../../src/engine/project-instructions.ts";
import {
    collectContextualPromptContributions,
    DEFAULT_PROMPT_CONTRIBUTION_ORDER,
    validatePromptContributionOrder,
} from "../../src/engine/prompt-contributions.ts";
import {
    createProtocolEncoder,
    type AgentUpdateSender,
} from "../../src/engine/protocol.ts";
import { loadRules } from "../../src/engine/rules.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const DATE = new Date("2026-11-23T12:00:00.000Z");
const originalHome = process.env.VERA_HOME;
const roots: string[] = [];

afterEach(async () => {
    process.env.VERA_HOME = originalHome ?? process.env.VERA_TEST_HOME!;
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function tempRoot(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-user-instructions-")));
    roots.push(root);
    return root;
}

test("@core the home AGENTS.md loads, and the home AGENTS.local.md does not", async () => {
    const home = await tempRoot();
    await writeFile(join(home, "AGENTS.md"), "Answer in British English.\n\n@style.md\n");
    await writeFile(join(home, "style.md"), "Short paragraphs.\n");
    await writeFile(join(home, "AGENTS.local.md"), "Never read.\n");

    const snapshot = await loadUserInstructions(home);

    expect(snapshot.files.map((file) => [file.name, file.path, file.content])).toEqual([
        ["<home>/AGENTS.md", join(home, "AGENTS.md"), "Answer in British English.\n\n@style.md\n"],
        ["<home>/style.md", join(home, "style.md"), "Short paragraphs.\n"],
    ]);
    expect(snapshot.warnings).toEqual([]);
});

test("a missing home AGENTS.md is ordinary absence", async () => {
    const home = await tempRoot();
    const snapshot = await loadUserInstructions(home);
    expect(snapshot).toEqual({ files: [], warnings: [] });
    expect(assembleSystemPrompt({
        tools: [],
        workspace: home,
        date: DATE,
        userInstructions: snapshot,
    })).not.toContain("User instructions");
});

test("home AGENTS.md imports do not escape the home", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(root, "outside.md"), "outside\n");
    await writeFile(join(home, "AGENTS.md"), "@../outside.md\n");

    const snapshot = await loadUserInstructions(home);

    expect(snapshot.files.map((file) => file.name)).toEqual(["<home>/AGENTS.md"]);
    expect(snapshot.warnings).toEqual([
        `${join(root, "outside.md")} was not imported because it is outside the Vera home`,
    ]);
});

test("loading without a path reads the selected Vera home", async () => {
    const home = await tempRoot();
    process.env.VERA_HOME = home;
    await writeFile(join(home, "AGENTS.md"), "From the selected home.\n");
    const snapshot = await loadUserInstructions();
    expect(snapshot.files.map((file) => file.content)).toEqual(["From the selected home.\n"]);
});

test("@core user instructions render before user rules, project instructions and project rules", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const workspace = join(root, "project");
    await mkdir(join(home, "rules"), { recursive: true });
    await mkdir(join(workspace, ".vera", "rules"), { recursive: true });
    await writeFile(join(home, "AGENTS.md"), "home instructions\n");
    await writeFile(join(home, "rules", "home.md"), "home rule\n");
    await writeFile(join(workspace, "AGENTS.md"), "project instructions\n");
    await writeFile(join(workspace, ".vera", "rules", "project.md"), "project rule\n");

    const prompt = assembleSystemPrompt({
        tools: [],
        workspace,
        date: DATE,
        userInstructions: await loadUserInstructions(home),
        projectInstructions: await loadProjectInstructions(workspace),
        rules: await loadRules({
            user: join(home, "rules"),
            project: join(workspace, ".vera", "rules"),
        }),
    });

    expect(prompt).toContain("## User instructions\n### <home>/AGENTS.md\nhome instructions");
    const positions = [
        "## Date",
        "## User instructions",
        "## User rules",
        "## Project instructions",
        "## Project rules",
    ].map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("@core a saved order from before user instructions still loads and places them before user rules", () => {
    const saved = DEFAULT_PROMPT_CONTRIBUTION_ORDER.filter((id) =>
        id !== "core.user-instructions"
    );
    expect(() => validatePromptContributionOrder(saved)).not.toThrow();
    const ids = collectContextualPromptContributions({
        date: DATE,
        contributionOrder: saved,
        userInstructions: {
            files: [{ name: "<home>/AGENTS.md", path: "/h/AGENTS.md", content: "x", bytes: 1, sha256: "" }],
            warnings: [],
        },
        rules: {
            rules: [{
                scope: "user",
                path: "/h/rules/a.md",
                displayPath: "<home>/rules/a.md",
                paths: [],
                body: "rule",
            }],
            warnings: [],
        } as never,
    }).map((contribution) => contribution.id);
    expect(ids.indexOf("core.user-instructions")).toBe(ids.indexOf("core.user-rules") - 1);
});

test("the home AGENTS.md shows in /context as a user part", async () => {
    const home = await tempRoot();
    await writeFile(join(home, "AGENTS.md"), "@notes.md\n");
    await writeFile(join(home, "notes.md"), "notes\n");
    const parts = contextContributionParts({
        userInstructions: await loadUserInstructions(home),
    });
    expect(parts["core.user-instructions"]?.map((part) => ({
        displayName: part.displayName,
        scope: part.scope,
        imported: part.imported === true,
    }))).toEqual([
        { displayName: "<home>/AGENTS.md", scope: "user", imported: false },
        { displayName: "<home>/notes.md", scope: "user", imported: true },
    ]);
});

test("@core a turn sends the home AGENTS.md, keeps the prompt identical while it is unchanged, and picks up an edit on the next turn", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const chatFolder = join(root, "chat");
    await mkdir(home);
    await mkdir(chatFolder);
    await writeFile(join(chatFolder, "note.txt"), "ahoy\n");
    process.env.VERA_HOME = home;
    await writeFile(join(home, "AGENTS.md"), "Call me Captain.\n");

    const requests: ModelRequest[] = [];
    const { channel, state } = setupTurn(chatFolder, [
        toolCall("call_read", "read", { path: "note.txt" }),
        assistantText("first"),
        assistantText("second"),
    ], requests);

    await sendTurn(channel, state, "hello");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.systemPrompt).toContain("## User instructions\n### <home>/AGENTS.md\nCall me Captain.");
    expect(requests[1]?.systemPrompt).toBe(requests[0]?.systemPrompt);

    await writeFile(join(home, "AGENTS.md"), "Call me Admiral.\n");
    await sendTurn(channel, state, "again");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.systemPrompt).toContain("Call me Admiral.");
    expect(requests[2]?.systemPrompt).not.toContain("Call me Captain.");
});

test("loadOptionalContext false leaves the home AGENTS.md out", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const workspace = join(root, "project");
    await mkdir(home);
    await mkdir(workspace);
    process.env.VERA_HOME = home;
    await writeFile(join(home, "AGENTS.md"), "Call me Captain.\n");

    const requests: ModelRequest[] = [];
    const { channel, state } = setupTurn(workspace, [assistantText("done")], requests, {
        loadOptionalContext: false,
    });
    await sendTurn(channel, state, "hello");
    expect(requests[0]?.systemPrompt).not.toContain("User instructions");
});

function setupTurn(
    workspace: string,
    responses: readonly AssistantMessage[],
    requests: ModelRequest[],
    options: { readonly loadOptionalContext?: boolean } = {},
): {
    readonly channel: ReturnType<typeof createInProcessChannel>;
    readonly state: RunTurnState;
} {
    const faux = new FauxAdapter([...responses]);
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine as AgentUpdateSender));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        ...(options.loadOptionalContext === undefined
            ? {}
            : { loadOptionalContext: options.loadOptionalContext }),
    };
    turnAdapters.set(state, adapter);
    return { channel, state };
}

const turnAdapters = new WeakMap<RunTurnState, ModelAdapter>();

async function sendTurn(
    channel: ReturnType<typeof createInProcessChannel>,
    state: RunTurnState,
    content: string,
): Promise<void> {
    channel.client.send({ type: "prompt", content });
    const turn = runTurn(turnAdapters.get(state)!, "test", state);
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "turn_finished") break;
    }
    await turn;
}

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
