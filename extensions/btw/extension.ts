import {
    decideSidekickSync,
    SIDEKICK_APPROVAL_MODE,
    SIDEKICK_BUSY_NOTICE,
    SIDEKICK_LIFETIME,
    SIDEKICK_MENTION,
    sidekickBranchOptions,
} from "../../src/sidekick/branch.ts";

const SIDEKICK = SIDEKICK_MENTION;
const PEER = "peer";

/** These commands are policy; Vera owns hosted agents, attachment, and rendering. */
export function activateClient(vera: any): void {
    const agents: Record<string, string | undefined> = {};
    const sidekickBranch = sidekickBranchOptions();
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

    /** Shared by `/btw close` / `/pair close` and the generic `/close` hook. */
    function closeSidebar(): void {
        vera.ui.sidebar.close();
        activeMention = undefined;
        setAddressing(SIDEKICK);
        offerVisibleMentions();
    }

    // `"stale"` and `"busy"` are decided in the shared sidekick module; a busy primary is a soft notice, not an error.
    async function syncPrimaryContext(
        agentId: string,
        signal: AbortSignal,
        ignoreBusy: boolean = false,
    ): Promise<"ok" | "stale" | "busy"> {
        const synced = await vera.agents.syncContext(agentId, signal);
        const decision = decideSidekickSync(synced.outcome, ignoreBusy);
        if (decision === "busy") {
            vera.ui.notice(SIDEKICK_BUSY_NOTICE, { tone: "soft" });
        }
        return decision;
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
                        hideInheritedMessages: sidekickBranch.hideInheritedMessages,
                        initialMessages: sidekickBranch.initialMessages,
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
                if (text.toLowerCase() === "close") {
                    closeSidebar();
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
                    if (inheritPrimary) {
                        const synced = await syncPrimaryContext(target, signal);
                        if (synced === "busy") {
                            return;
                        }
                        if (synced === "stale") {
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
        SIDEKICK_APPROVAL_MODE,
        SIDEKICK_LIFETIME,
        true,
        "Open or message a readonly sidekick",
    );

    // Bare prompts bypass slash-command dispatch. Catch the sidekick up
    // with completed primary turns, including a message aimed at the
    // sidekick. A busy agent must not block the prompt; `/btw message`
    // still refuses to sync mid-turn.
    vera.messages.intercept(
        async (
            message: { text: string; workspace: string },
            signal: AbortSignal,
        ) => {
            const target = agents[SIDEKICK];
            if (
                target !== undefined
                && await syncPrimaryContext(target, signal, true) === "stale"
            ) {
                agents[SIDEKICK] = undefined;
                await openAgent(
                    "btw",
                    SIDEKICK,
                    SIDEKICK_APPROVAL_MODE,
                    SIDEKICK_LIFETIME,
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

    // Lets the client close this pane generically (for example `/close`
    // while it is the focused pane) without the client naming this extension.
    vera.ui.sidebar.onCloseRequested(closeSidebar);
}
