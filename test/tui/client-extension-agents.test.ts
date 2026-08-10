import { expect, test } from "bun:test";

import {
    createTuiClientExtensionAgentsAdapter,
} from "../../clients/tui/client-extension-agents.ts";
import { TuiAgentPane } from "../../clients/tui/agent-pane.ts";
import type { IdentifiedTuiAgentClient } from "../../clients/tui/agent-client.ts";
import type { ClientCommand } from "../../src/engine/protocol.ts";

function agent(agentId?: string): IdentifiedTuiAgentClient {
    return {
        agentId: agentId ?? "main",
        workspace: "/workspace",
        async send() {},
        async receive() { return await new Promise(() => {}); },
        async detach() {},
        close() {},
    };
}

test("extension agents expose the current primary and sidebar snapshot", () => {
    const side = new TuiAgentPane({ client: agent("side") });
    const adapter = createTuiClientExtensionAgentsAdapter({
        primary: () => agent("main"),
        sidebar: () => side,
        sidebarMention: () => "critic",
        async adoptAgent() {},
    });

    expect(adapter.visible("extension")).toEqual([
        { agentId: "main", pane: "main" },
        { agentId: "side", pane: "sidebar", mention: "critic" },
    ]);
});

test("extension agents create and open identified clients through one seam", async () => {
    const opened: string[] = [];
    const adapter = createTuiClientExtensionAgentsAdapter({
        primary: () => agent("main"),
        sidebar: () => undefined,
        sidebarMention: () => undefined,
        createAgent: async () => agent("created"),
        attachAgent: async (agentId) => agent(agentId),
        async adoptAgent(_extensionId, client) {
            opened.push(client.agentId);
        },
    });

    await expect(adapter.create("extension", {
        pane: "sidebar",
        approvalMode: "readonly",
        attachmentLifetime: "ephemeral",
    }, new AbortController().signal)).resolves.toEqual({ agentId: "created" });
    await adapter.open("extension", {
        agentId: "existing",
        pane: "sidebar",
    }, new AbortController().signal);
    expect(opened).toEqual(["created", "existing"]);
});

test("cancelling creation closes the unadopted client", async () => {
    const creation = Promise.withResolvers<IdentifiedTuiAgentClient>();
    let closed = false;
    let adopted = false;
    const created = agent("created");
    created.close = () => { closed = true; };
    const adapter = createTuiClientExtensionAgentsAdapter({
        primary: () => agent("main"),
        sidebar: () => undefined,
        sidebarMention: () => undefined,
        createAgent: () => creation.promise,
        async adoptAgent() { adopted = true; },
    });
    const controller = new AbortController();
    const pending = adapter.create("extension", {
        pane: "sidebar",
    }, controller.signal);

    controller.abort(new Error("cancelled"));
    creation.resolve(created);
    await expect(pending).rejects.toThrow("cancelled");
    expect(closed).toBe(true);
    expect(adopted).toBe(false);
});

test("extension agents branch only from a visible hosted agent", async () => {
    const branched: unknown[] = [];
    const adapter = createTuiClientExtensionAgentsAdapter({
        primary: () => ({
            ...agent("main"),
            supportsHostCapability: () => true,
        }),
        sidebar: () => undefined,
        sidebarMention: () => undefined,
        branchAgent: async (...options) => {
            branched.push(options.slice(0, 4));
            return agent("branch");
        },
        async adoptAgent() {},
    });
    const signal = new AbortController().signal;
    await expect(adapter.create("extension", {
        pane: "sidebar",
        source: { type: "branch", agentId: "main" },
        approvalMode: "readonly",
        attachmentLifetime: "ephemeral",
        initialMessages: [{ role: "user", text: "boundary", hidden: true }],
    }, signal)).resolves.toEqual({ agentId: "branch" });
    expect(branched).toEqual([[
        "main",
        "readonly",
        "ephemeral",
        [{
            role: "user",
            content: [{ type: "text", text: "boundary" }],
            internal: true,
        }],
    ]]);
    await expect(adapter.create("extension", {
        pane: "sidebar",
        source: { type: "branch", agentId: "hidden" },
    }, signal)).rejects.toThrow("only a visible agent");
});

test("extension agent messages attach sidebar images before sending", async () => {
    const sent: ClientCommand[] = [];
    const sideClient = agent("side");
    sideClient.send = async (command) => { sent.push(command); };
    const side = new TuiAgentPane({ client: sideClient });
    side.attachImage = async (_requestId, path) => ({
        id: `attachment:${path}`,
    });
    const adapter = createTuiClientExtensionAgentsAdapter({
        primary: () => agent("main"),
        sidebar: () => side,
        sidebarMention: () => "sidekick",
        async adoptAgent() {},
    });

    await adapter.message("extension", {
        agentId: "side",
        text: "inspect",
        imagePaths: ["image.png"],
    }, new AbortController().signal);
    expect(sent).toEqual([{
        type: "prompt",
        content: "inspect",
        attachmentIds: ["attachment:image.png"],
    }]);
});
