import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OVERLAY_COMMANDS } from "../../clients/ui/src/commands/overlay-ids.ts";
import { NewAgentPill } from "../../clients/ui/src/composer/NewAgentPill.tsx";
import {
    agentToStart,
    holdFirstTurn,
    reconcilePick,
    shownAgent,
    type NewSessionAgents,
} from "../../clients/ui/src/composer/newAgent.ts";
import { currentNewChatAgents, publishNewChatAgents } from "../../clients/ui/src/composer/newChatAgents.ts";
import { buildSlashEntries } from "../../clients/ui/src/composer/slash/model.ts";
import { runSlashEntry, type SlashRunContext } from "../../clients/ui/src/composer/slash/run.ts";
import { parseCatalogLine, type AgentInfo, type CatalogReply } from "../../clients/ui/src/customize/wire.ts";
import { NO_AGENT_START, startAfterReply, stepAgentGate, type AgentStart } from "../../clients/ui/src/session/agentGate.ts";
import { takePendingAgent } from "../../clients/ui/src/session/pendingAgent.ts";
import { takePendingPrompt } from "../../clients/ui/src/session/pendingPrompt.ts";
import { WorkbenchContext, type WorkbenchApi } from "../../clients/ui/src/workbench/context.tsx";

function agent(name: string, scope: AgentInfo["scope"] = "user"): AgentInfo {
    return { name, scope, writable: scope !== "extension" };
}

function listing(folder: string | undefined, names: readonly string[]): NewSessionAgents {
    return { folder, startsOn: "default", agents: names.map((name) => agent(name)), notices: [] };
}

const NEST = listing("/nest", ["default", "chat", "scout", "plan"]);
const SHORE = listing("/shore", ["default", "chat", "scout"]);

describe("the agent pill", () => {
    function render(agentName: string, disabled: boolean, run: WorkbenchApi["run"] = () => undefined): string {
        const api = { run } as unknown as WorkbenchApi;
        return renderToStaticMarkup(createElement(WorkbenchContext.Provider, { value: api }, createElement(NewAgentPill, { agent: agentName, disabled })));
    }

    test("@core shows the agent the new session starts on and says what it opens", () => {
        const html = render("default", false);
        expect(html).toContain('data-agent="default"');
        expect(html).toContain('<span class="pill-label">default</span>');
        expect(html).toContain("Choose the agent this session runs as");
        expect(html).not.toContain("disabled");
    });

    test("shows a picked agent and is disabled while the chat is being created", () => {
        const html = render("plan", true);
        expect(html).toContain('<span class="pill-label">plan</span>');
        expect(html).toContain("disabled");
    });

    test("opens the same Choose Agent sheet the session pill opens", () => {
        expect(OVERLAY_COMMANDS.agent.id).toBe("session.chooseAgent");
    });
});

describe("the pick against the folder's list", () => {
    test("@core a pick the list offers stays, and no pick shows what the session starts on", () => {
        expect(reconcilePick("plan", NEST)).toEqual({ pick: "plan" });
        expect(reconcilePick(undefined, NEST)).toEqual({ pick: undefined });
        expect(shownAgent(undefined, NEST)).toBe("default");
        expect(shownAgent("plan", NEST)).toBe("plan");
    });

    test("@core a pick the new folder does not offer falls back to the default and says so", () => {
        const outcome = reconcilePick("plan", SHORE);
        expect(outcome.pick).toBeUndefined();
        expect(outcome.notice).toBe("The plan agent is not offered here. This chat starts on default.");
        expect(shownAgent(outcome.pick, SHORE)).toBe("default");
    });

    test("a chat offers no project agents, so a project pick falls back there too", () => {
        const chat = listing(undefined, ["default", "chat", "scout"]);
        expect(reconcilePick("plan", chat).notice).toBe("The plan agent is not offered here. This chat starts on default.");
        expect(reconcilePick("scout", chat)).toEqual({ pick: "scout" });
    });

    test("@core the default, picked or not, sends nothing extra", () => {
        expect(agentToStart(undefined, NEST)).toBeUndefined();
        expect(agentToStart("default", NEST)).toBeUndefined();
        expect(agentToStart("plan", NEST)).toBe("plan");
        expect(agentToStart("plan", undefined)).toBeUndefined();
    });
});

describe("the first message waits for the agent", () => {
    const prompt = { text: "hello", images: [], files: [] };

    test("@core a pick queues the switch and holds the prompt for it", () => {
        holdFirstTurn("crow-1", "plan", prompt);
        expect(takePendingAgent("crow-1")).toBe("plan");
        expect(takePendingPrompt("crow-1")).toEqual({ ...prompt, agent: "plan" });
    });

    test("@core no pick queues no switch and the prompt carries no agent", () => {
        holdFirstTurn("crow-2", undefined, prompt);
        expect(takePendingAgent("crow-2")).toBeUndefined();
        const held = takePendingPrompt("crow-2");
        expect(held).toEqual(prompt);
        expect(held?.agent).toBeUndefined();
    });

    function reply(value: Record<string, unknown>): CatalogReply {
        const parsed = parseCatalogLine(JSON.stringify(value));
        if (parsed === undefined) throw new Error("not a catalog reply");
        return parsed;
    }

    test("@core the prompt goes out only after the session confirms the agent it was held for", () => {
        let start: AgentStart = NO_AGENT_START;
        expect(stepAgentGate(start, "plan")).toEqual({ kind: "wait" });

        start = { name: "plan", selected: false };
        expect(stepAgentGate(start, "plan")).toEqual({ kind: "wait" });

        start = startAfterReply(start, reply({ type: "agent_selected", requestId: "r1", name: "plan" }), "r1");
        expect(stepAgentGate(start, "plan")).toEqual({ kind: "send" });
    });

    test("@core a refused switch gives the text back with the session's reason", () => {
        let start: AgentStart = { name: "plan", selected: false };
        start = startAfterReply(start, reply({ type: "agent_rejected", requestId: "r1", reason: "No agent named plan" }), "r1");
        expect(stepAgentGate(start, "plan")).toEqual({ kind: "restore", reason: "No agent named plan" });
    });

    test("an answer to some other request changes nothing", () => {
        const start: AgentStart = { name: "plan", selected: false };
        expect(startAfterReply(start, reply({ type: "agent_selected", requestId: "other", name: "plan" }), "r1")).toBe(start);
        expect(startAfterReply(start, reply({ type: "agent_rejected", requestId: "other", reason: "No" }), "r1")).toBe(start);
        expect(startAfterReply(start, reply({ type: "agent_selected", requestId: "r1", name: "plan" }), undefined)).toBe(start);
    });

    test("a confirmation of a different agent does not release a prompt held for this one", () => {
        const start: AgentStart = { name: "scout", selected: true };
        expect(stepAgentGate(start, "plan")).toEqual({ kind: "wait" });
    });

    test("the start of a previous session does not release the next one's prompt", () => {
        expect(stepAgentGate(NO_AGENT_START, "plan")).toEqual({ kind: "wait" });
    });
});

describe("/agent on a new chat", () => {
    const entries = buildSlashEntries([], []);
    const agentEntry = entries.find((candidate) => candidate.name === "agent");
    if (agentEntry === undefined) throw new Error("no /agent entry");

    function context(): { readonly context: SlashRunContext; readonly notes: string[]; readonly ran: string[] } {
        const notes: string[] = [];
        const ran: string[] = [];
        return {
            notes,
            ran,
            context: {
                session: undefined,
                run: (command) => ran.push(command),
                notify: (text) => notes.push(text),
                restore: () => undefined,
            },
        };
    }

    let withdraw: (() => void) | undefined;
    afterEach(() => {
        withdraw?.();
        withdraw = undefined;
    });

    test("@core with no name it opens the Choose Agent sheet", async () => {
        const run = context();
        await runSlashEntry(agentEntry, "", run.context);
        expect(run.ran).toEqual([OVERLAY_COMMANDS.agent.id]);
    });

    test("@core with a name the composer offers it picks directly", async () => {
        const picked: string[] = [];
        withdraw = publishNewChatAgents({ agents: NEST.agents, selected: "default", pick: (name) => picked.push(name) });
        const run = context();
        await runSlashEntry(agentEntry, "plan", run.context);
        expect(picked).toEqual(["plan"]);
        expect(run.notes).toEqual(["Agent: plan"]);
    });

    test("a name the list does not offer picks nothing", async () => {
        const picked: string[] = [];
        withdraw = publishNewChatAgents({ agents: SHORE.agents, selected: "default", pick: (name) => picked.push(name) });
        const run = context();
        await runSlashEntry(agentEntry, "plan", run.context);
        expect(picked).toEqual([]);
        expect(run.notes).toEqual(["No agent named plan"]);
    });

    test("with no list on offer it still needs an open session", async () => {
        const run = context();
        await runSlashEntry(agentEntry, "plan", run.context);
        expect(run.notes).toEqual(["/agent needs an open session"]);
    });
});

describe("the list a new chat publishes", () => {
    test("@core a later list replaces the earlier one, and an old composer cannot withdraw the new one", () => {
        const first = publishNewChatAgents({ agents: NEST.agents, selected: "default", pick: () => undefined });
        const second = publishNewChatAgents({ agents: SHORE.agents, selected: "default", pick: () => undefined });
        expect(currentNewChatAgents()?.agents).toBe(SHORE.agents);
        first();
        expect(currentNewChatAgents()?.agents).toBe(SHORE.agents);
        second();
        expect(currentNewChatAgents()).toBeUndefined();
    });
});
