import { TextRenderable } from "@opentui/core";

const SIDEKICK = "sidekick";
const PEER = "peer";
const SIDE_CONVERSATION_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the primary conversation. It is reference context only, not your current task.

Do not continue or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active instructions for this side conversation.

You are a separate, readonly side-conversation assistant. Answer questions and perform lightweight, non-mutating exploration without disrupting the primary conversation.`;

/** These commands are policy; Vera owns hosted agents, attachment, and rendering. */
export function activateClient(vera: any): void {
    const agents: Record<string, string | undefined> = {};
    let activeMention: string | undefined;
    let activeMode: "btw" | "pair" | undefined;
    let modeStatus: TextRenderable | undefined;
    let requestModeRender: (() => void) | undefined;

    function modeStatusText(): string {
        const surface = vera.experimentalTui.agentSurface.current();
        if (activeMode === undefined || surface === undefined) return "";
        const layout = surface.layout === "secondary"
            ? `${activeMode} only`
            : surface.layout === "primary" ? "vera only" : "split";
        const focus = surface.layout === "split"
            ? surface.focused === "secondary"
                ? "ctrl+g vera"
                : `ctrl+g ${activeMention}`
            : undefined;
        return [
            `${activeMode} mode`,
            layout,
            "ctrl+/ layout",
            ...(focus === undefined ? [] : [focus]),
        ].join(" · ");
    }

    function renderModeStatus(): void {
        if (modeStatus !== undefined) {
            modeStatus.content = modeStatusText();
        }
        requestModeRender?.();
    }

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

    async function openAgent(
        statusLabel: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        attachmentLifetime: "ephemeral" | "durable",
        inheritPrimary: boolean,
        workspace: string,
        signal: AbortSignal,
    ): Promise<string> {
        let agentId = agents[mention]
            ?? vera.agents.visible().find((agent: { mention?: string }) =>
                agent.mention === mention
            )?.agentId;
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
                        initialMessages: [{
                            role: "user",
                            text: SIDE_CONVERSATION_BOUNDARY,
                            hidden: true,
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
        activeMode = statusLabel;
        setAddressing(mention);
        offerVisibleMentions();
        renderModeStatus();
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
                const target = await openAgent(
                    name,
                    mention,
                    approvalMode,
                    attachmentLifetime,
                    inheritPrimary,
                    workspace,
                    signal,
                );
                const text = argumentsText.trim();
                if (text.length > 0 || imagePaths.length > 0) {
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
    register(
        "pair",
        PEER,
        "ask",
        "durable",
        false,
        "Open or message a tool-capable peer",
    );

    vera.experimentalTui.mountRenderable({
        id: "agent-mode",
        slot: "footer",
        visible: () => activeMode !== undefined
            && vera.experimentalTui.agentSurface.current() !== undefined,
        create(context: any) {
            requestModeRender = context.requestRender;
            modeStatus = new TextRenderable(context.renderer, {
                id: "btw-agent-mode",
                content: modeStatusText(),
                fg: context.theme.muted,
                height: 1,
                width: "100%",
            });
            return modeStatus;
        },
    });

    vera.keybindings.register({
        id: "cycle-agent-layout",
        description: "Cycle split and single-agent layouts",
        keys: ["ctrl+/", "ctrl+_"],
        run() {
            if (vera.experimentalTui.agentSurface.cycleLayout()) {
                renderModeStatus();
            }
        },
    });
    vera.keybindings.register({
        id: "switch-agent-pane",
        description: "Switch focus between visible agents",
        keys: ["ctrl+g"],
        run() {
            if (vera.experimentalTui.agentSurface.toggleFocus()) {
                renderModeStatus();
            }
        },
    });

    vera.conversation.onChanged(() => {
        agents[SIDEKICK] = undefined;
        agents[PEER] = undefined;
        activeMention = undefined;
        activeMode = undefined;
        setAddressing(SIDEKICK);
        offerVisibleMentions();
        renderModeStatus();
    });

    const restoredMention = vera.agents.visible().find(
        (agent: { pane: string; mention?: string }) =>
            agent.pane === "sidebar"
            && (agent.mention === SIDEKICK || agent.mention === PEER),
    )?.mention;
    if (restoredMention !== undefined) {
        activeMention = restoredMention;
        activeMode = restoredMention === PEER ? "pair" : "btw";
    }
    setAddressing(activeMention ?? SIDEKICK);
    offerVisibleMentions();
}
