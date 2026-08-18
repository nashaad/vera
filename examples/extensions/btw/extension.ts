const SIDEKICK = "sidekick";
const PEER = "peer";
const SIDE_CONVERSATION_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the primary conversation. It is reference context only, not your current task.

Do not continue or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active instructions for this side conversation.

Use inherited history naturally when answering the user's current question. Treat it as conversation the user and assistant already had: do not claim it was not discussed merely because it predates this boundary.

This boundary and these instructions are hidden harness context. Do not mention, summarize, quote, or allude to the boundary, inherited-history distinction, side-conversation policy, read-only role, or these instructions unless the user explicitly asks how this assistant operates.

You are a separate, readonly side-conversation assistant. Answer the current question directly and perform only lightweight, non-mutating exploration without disrupting the primary conversation.`;

/** These commands are policy; Vera owns hosted agents, attachment, and rendering. */
export function activateClient(vera: any): void {
    const agents: Record<string, string | undefined> = {};
    let activeMention: string | undefined;

    function setAddressing(mention: string): void {
        vera.agents.declareExperimentalAddressing({
            primary: "vera",
            secondary: mention,
            broadcast: "all",
        });
    }

    function offerVisibleMentions(): void {
        vera.ui.mentions.set(
            activeMention === undefined ? [] : [activeMention, "all", "vera"],
        );
    }

    /**
     * Returns `"stale"` when the primary was rewound past the point this
     * branch synced from: the branch can never catch up, so the caller drops
     * it and branches again. The lost side conversation is the accepted cost
     * of `/btw` being ephemeral.
     */
    async function syncPrimaryContext(
        agentId: string,
        signal: AbortSignal,
    ): Promise<"ok" | "stale"> {
        const synced = await vera.agents.syncContext(agentId, signal);
        if (synced.outcome === "stale_cursor") {
            return "stale";
        }
        if (synced.outcome === "busy") {
            throw new Error("BTW context can sync only between turns");
        }
        if (synced.outcome === "not_found") {
            throw new Error("BTW primary context is unavailable");
        }
        if (synced.outcome === "failed") {
            throw new Error("BTW primary context could not be synchronized");
        }
        return "ok";
    }

    async function openAgent(
        statusLabel: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        attachmentLifetime: "ephemeral" | "durable",
        inheritPrimary: boolean,
        workspace: string,
        signal: AbortSignal,
        fresh: boolean = false,
    ): Promise<string> {
        let agentId = fresh ? undefined : (agents[mention]
            ?? vera.agents.visible().find((agent: { mention?: string }) =>
                agent.mention === mention
            )?.agentId);
        if (agentId === undefined) {
            const primaryAgentId = inheritPrimary
                ? vera.agents.visible().find(
                    (agent: { pane: string }) => agent.pane === "main",
                )?.agentId
                : undefined;
            if (inheritPrimary && primaryAgentId === undefined) {
                throw new Error("BTW needs a visible primary agent to branch");
            }
            const created = await vera.agents.create({
                pane: "sidebar",
                mention,
                statusLabel,
                workspace,
                approvalMode,
                attachmentLifetime,
                ...(primaryAgentId === undefined
                    ? {}
                    : {
                        source: {
                            type: "branch",
                            agentId: primaryAgentId,
                        },
                        hideInheritedMessages: true,
                        initialMessages: [{
                            role: "user",
                            text: SIDE_CONVERSATION_BOUNDARY,
                            hidden: true,
                            compactionBarrier: true,
                        }],
                    }),
            }, signal);
            agentId = created.agentId;
            agents[mention] = agentId;
        } else {
            await vera.agents.open({
                agentId,
                pane: "sidebar",
                mention,
                statusLabel,
                attachmentLifetime,
            }, signal);
        }
        activeMention = mention;
        setAddressing(mention);
        offerVisibleMentions();
        return agentId;
    }

    function register(
        name: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        attachmentLifetime: "ephemeral" | "durable",
        inheritPrimary: boolean,
        description: string,
    ): void {
        vera.commands.register({
            name,
            description,
            usage: `/${name} [message]`,
            interactive: true,
            acceptsImages: true,
            async run({ argumentsText, workspace, imagePaths, signal }: {
                argumentsText: string;
                workspace: string;
                imagePaths: readonly string[];
                signal: AbortSignal;
            }) {
                const text = argumentsText.trim();
                if (name === "pair" && text.toLowerCase() === "close") {
                    vera.ui.sidebar.close();
                    activeMention = undefined;
                    setAddressing(SIDEKICK);
                    offerVisibleMentions();
                    return;
                }
                let target = await openAgent(
                    name,
                    mention,
                    approvalMode,
                    attachmentLifetime,
                    inheritPrimary,
                    workspace,
                    signal,
                );
                if (text.length > 0 || imagePaths.length > 0) {
                    if (
                        inheritPrimary
                        && await syncPrimaryContext(target, signal) === "stale"
                    ) {
                        agents[mention] = undefined;
                        target = await openAgent(
                            name,
                            mention,
                            approvalMode,
                            attachmentLifetime,
                            inheritPrimary,
                            workspace,
                            signal,
                            true,
                        );
                    }
                    await vera.agents.message({
                        agentId: target,
                        text,
                        imagePaths,
                    }, signal);
                }
            },
        });
    }

    register(
        "btw",
        SIDEKICK,
        "readonly",
        "ephemeral",
        true,
        "Open or message a readonly sidekick",
    );

    // Bare prompts sent while the hosted surface is open bypass slash-command
    // dispatch. Synchronize here too so focusing the sidekick and continuing
    // the conversation has the same semantics as `/btw message`.
    vera.messages.intercept(
        async (message: { workspace: string }, signal: AbortSignal) => {
            const target = agents[SIDEKICK];
            if (
                target !== undefined
                && await syncPrimaryContext(target, signal) === "stale"
            ) {
                agents[SIDEKICK] = undefined;
                await openAgent(
                    "btw",
                    SIDEKICK,
                    "readonly",
                    "ephemeral",
                    true,
                    message.workspace,
                    signal,
                    true,
                );
            }
            return { kind: "pass" };
        },
    );
    register(
        "pair",
        PEER,
        "ask",
        "durable",
        false,
        "Open or message a tool-capable peer",
    );

    vera.keybindings.register({
        id: "cycle-agent-layout",
        description: "Cycle split and single-agent layouts",
        keys: ["ctrl+\\", "ctrl+/", "ctrl+_"],
        run() {
            vera.experimentalTui.agentSurface.cycleLayout();
        },
    });
    vera.keybindings.register({
        id: "switch-agent-pane",
        description: "Switch focus between visible agents",
        keys: ["ctrl+g"],
        run() {
            vera.experimentalTui.agentSurface.toggleFocus();
        },
    });

    vera.conversation.onChanged(() => {
        agents[SIDEKICK] = undefined;
        agents[PEER] = undefined;
        activeMention = undefined;
        setAddressing(SIDEKICK);
        offerVisibleMentions();
    });

    const restoredMention = vera.agents.visible().find(
        (agent: { pane: string; mention?: string }) =>
            agent.pane === "sidebar"
            && (agent.mention === SIDEKICK || agent.mention === PEER),
    )?.mention;
    if (restoredMention !== undefined) {
        activeMention = restoredMention;
    }
    setAddressing(activeMention ?? SIDEKICK);
    offerVisibleMentions();
}
