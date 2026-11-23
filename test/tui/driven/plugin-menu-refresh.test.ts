import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient, TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { loadAgentCatalog } from "../../../src/agents/catalog.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from "../../../src/host/capabilities.ts";
import { emptyUsage, type AssistantMessage } from "../../../src/model/types.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../../src/plugins/naming.ts";
import { loadSkillCommandCatalog } from "../../../src/skills/commands.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";

test("plugin changes refresh skill commands and the cached agent list", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-tui-plugin-refresh-"));
    const source = join(root, "source");
    mkdirSync(join(source, "skills", "deploy"), { recursive: true });
    mkdirSync(join(source, "dev.vera", "agents"), { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "sample-plugin",
    }));
    writeFileSync(
        join(source, "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy the current service\n---\n\nDeploy.\n",
    );
    writeFileSync(
        join(source, "dev.vera", "agents", "scribe.md"),
        "---\ndescription: Writes it down\n---\n\nWrite.\n",
    );
    const extension = join(root, "extension");
    mkdirSync(extension);
    writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
        id: "crow.test", version: "1.0.0", sdk: "1",
        entrypoint: "extension.ts", capabilities: [],
    }));
    writeFileSync(join(extension, "extension.ts"), "export default {};\n");

    const signals = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("Test must not send signals");
    });
    const commands: ClientCommand[] = [];
    const agentLists: string[][] = [];
    let session: TuiTestSession | undefined;
    try {
        session = await startTuiTestSession({
            home: join(root, "home"),
            dependencies: () => dependencies(commands, agentLists),
        });
        await session.waitForVisiblePane("Start a conversation");
        await session.settle(150);

        session.sendText("/plugins");
        session.sendKey("Enter");
        const browser = await session.waitForVisiblePane("Instructions");
        expect(browser).toContain("Agents");
        session.sendKey("Escape");
        await session.settle(150);

        session.sendText("/plugins li");
        await session.waitForVisiblePane("list");
        session.sendKey("Tab");
        await session.waitForVisiblePane("/plugins list");
        session.sendKey("Enter");
        await session.waitForVisiblePane("No plugins installed.");
        session.sendKey("Escape");
        await session.settle(150);

        session.sendText("/agent");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Agents");
        expect(agentLists.at(-1)).not.toContain("scribe");
        session.sendKey("Escape");
        await session.settle(100);

        let skills = countCommands(commands, "list_skills");
        let agents = countCommands(commands, "list_agents");
        const installed = await dialog(session, `/plugins install ${source}`, "Plugin install");
        expect(installed).toMatch(/version:\s+-/);
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        expect(countCommands(commands, "list_agents")).toBe(++agents);
        await waitForAgentList(agentLists, true);

        session.sendText("/dep");
        await session.waitForVisiblePane("/deploy");
        session.sendKey("Escape");
        await session.settle(100);
        session.sendText("/agent");
        session.sendKey("Enter");
        await session.waitForVisiblePane("scribe");
        session.sendKey("Escape");
        await session.settle(100);

        const listed = await dialog(session, "/plugins list", "sample-plugin");
        expect(listed).toMatch(/sample-plugin\s+-\s+enabled/);
        const aliasListed = await dialog(session, "/plugin list", "sample-plugin");
        expect(aliasListed).toMatch(/sample-plugin\s+-\s+enabled/);
        session.sendText("/customize");
        session.sendKey("Enter");
        const aliasBrowser = await session.waitForVisiblePane("Instructions");
        expect(aliasBrowser).toContain("Agents");
        session.sendKey("Escape");
        await session.settle(150);
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        await dialog(session, `/extension install ${extension} --dry-run`,
            "Extension folders install as plugins", "Extensions");
        const shown = await dialog(session, "/plugins show sample-plugin", "Plugin sample-plugin");
        expect(shown).toMatch(/version:\s+-/);
        const preview = await dialog(session, `/plugins install ${source} --dry-run`, "Plugin install plan");
        expect(preview).toMatch(/version:\s+-/);
        expect(countCommands(commands, "list_skills")).toBe(skills);
        expect(countCommands(commands, "list_agents")).toBe(agents);

        await notice(session, "/plugins disable sample-plugin", "Disabled sample-plugin");
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        expect(countCommands(commands, "list_agents")).toBe(++agents);
        await waitForAgentList(agentLists, false);
        session.sendText("/dep");
        await session.settle(250);
        expect(session.captureVisiblePane()).not.toContain("/deploy");
        session.sendKey("Escape");
        await session.settle(100);
        session.sendText("/agent");
        session.sendKey("Enter");
        const disabledAgents = await session.waitForVisiblePane("Agents");
        expect(disabledAgents).not.toContain("scribe");
        session.sendKey("Escape");
        await session.settle(100);

        await notice(session, "/plugins enable sample-plugin", "Enabled sample-plugin");
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        expect(countCommands(commands, "list_agents")).toBe(++agents);
        await waitForAgentList(agentLists, true);
        session.sendText("/dep");
        await session.waitForVisiblePane("/deploy");
        session.sendKey("Escape");
        await session.settle(100);
        session.sendText("/agent");
        session.sendKey("Enter");
        await session.waitForVisiblePane("scribe");
        session.sendKey("Escape");
        await session.settle(100);

        await dialog(session, "/plugins migrate", "No legacy extensions to migrate");
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        expect(countCommands(commands, "list_agents")).toBe(++agents);
        await notice(session, "/plugins remove sample-plugin", "Removed sample-plugin");
        expect(countCommands(commands, "list_skills")).toBe(++skills);
        expect(countCommands(commands, "list_agents")).toBe(++agents);
        await waitForAgentList(agentLists, false);

        await notice(session, "/plugins disable missing-plugin", "Plugin operation failed");
        expect(countCommands(commands, "list_skills")).toBe(skills);
        expect(countCommands(commands, "list_agents")).toBe(agents);
        expect(signals).not.toHaveBeenCalled();
    } finally {
        await session?.close();
        signals.mockRestore();
    }
}, 30_000);

test("home lists plugins and opens the browser in a new conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-tui-home-plugins-"));
    const commands: ClientCommand[] = [];
    const signals = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("Test must not send signals");
    });
    let created = 0;
    let session: TuiTestSession | undefined;
    try {
        session = await startTuiTestSession({
            home: join(root, "home"),
            dependencies: () => {
                const conversation = dependencies(commands, []);
                return {
                    ...conversation,
                    client: createHomeClient(process.cwd()),
                    homeHasSessions: false,
                    createSession: async () => {
                        created += 1;
                        return conversation.client;
                    },
                };
            },
        });
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/plug");
        const menu = await session.waitForVisiblePane("/plugins");
        expect(menu.split("\n").filter((line) => /\/plugins\s+Browse definitions/.test(line))).toHaveLength(1);
        expect(menu).not.toContain("/customize");
        session.sendText("ins");
        session.sendKey("Enter");
        const browser = await session.waitForVisiblePane("Instructions");
        expect(browser).toContain("Agents");
        expect(created).toBe(1);
        expect(signals).not.toHaveBeenCalled();
        session.sendKey("Escape");
    } finally {
        await session?.close();
        signals.mockRestore();
    }
}, 15_000);

function dependencies(commands: ClientCommand[], agentLists: string[][]): TuiDependencies {
    const channel = createInProcessChannel();
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    void runHeadlessLoop(channel.engine, new FauxAdapter([response]), "test", "high", {
        approvalMode: "auto",
    }, {
        readModelSettings: () => ({ model: "test", reasoningEffort: "high" }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: {
            updateModelSettings: async () => undefined,
            listSkills: () => loadSkillCommandCatalog({}),
            listAgents: async () => {
                const catalog = await loadAgentCatalog({});
                const agents = catalog.agents.map((agent) => ({
                    name: agent.definition.name,
                    scope: agent.scope,
                    writable: agent.writable,
                    ...(agent.plugin === undefined ? {} : { plugin: agent.plugin }),
                }));
                agentLists.push(agents.map((agent) => agent.name));
                return { selected: "default", agents, notices: catalog.notices };
            },
        },
    });
    const client: TuiAgentClient = {
        capabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
        supportsHostCapability: (capability) => capability === HOST_CAPABILITY_SKILL_COMMANDS,
        async send(command): Promise<void> {
            commands.push(command);
            channel.client.send(command);
        },
        receive: (signal) => channel.client.receive(signal),
        async detach(): Promise<void> {},
        close(): void {},
    };
    return { client };
}

function countCommands(commands: readonly ClientCommand[], type: ClientCommand["type"]): number {
    return commands.filter((command) => command.type === type).length;
}

async function dialog(
    session: TuiTestSession,
    command: string,
    text: string,
    title: "Plugins" | "Extensions" = "Plugins",
): Promise<string> {
    session.sendText(command);
    session.sendKey("Enter");
    const pane = await session.waitForVisiblePane(text);
    const header = pane.split("\n").find((line) =>
        /\b(?:Plugins|Extensions)\b/.test(line) && /\besc\b/i.test(line)
    );
    expect(header).toContain(title);
    if (title === "Extensions") {
        expect(pane).toContain("Managed installs stay outside the Vera release.");
    } else {
        expect(pane).not.toContain("Managed installs stay outside the Vera release.");
    }
    session.sendKey("Escape");
    await session.settle(150);
    return pane;
}

async function notice(session: TuiTestSession, command: string, text: string): Promise<void> {
    session.sendText(command);
    session.sendKey("Enter");
    await session.waitForVisiblePane(text);
    await session.settle(150);
}

async function waitForAgentList(agentLists: readonly string[][], includesScribe: boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (agentLists.at(-1)?.includes("scribe") === includesScribe) return;
        await Bun.sleep(20);
    }
    throw new Error(`Agent list did not ${includesScribe ? "include" : "exclude"} scribe`);
}
