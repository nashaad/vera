const SECONDARY_ALIAS = "critic";

/** A deliberately different experimental hosted-agent client extension. */
export async function activateClient(vera: any): Promise<void> {
    const saved = await vera.preferences.get("panel");
    const state = {
        count: typeof saved === "object"
                && saved !== null
                && !Array.isArray(saved)
                && typeof saved.count === "number"
            ? saved.count
            : 0,
        overlayOpen: false,
        latest: "No transcript turn yet",
    };

    async function persist(): Promise<void> {
        await vera.preferences.set("panel", { count: state.count });
    }

    vera.agents.declareExperimentalAddressing({
        primary: "author",
        secondary: SECONDARY_ALIAS,
    });

    vera.experimentalTui.events.on("transcript_changed", (transcript: readonly {
        role: "user" | "assistant";
        text: string;
    }[]) => {
        state.latest = transcript.at(-1)?.text.slice(0, 120)
            ?? "No transcript turn yet";
    });
    vera.experimentalTui.events.on("agent_event", (event: {
        type: string;
        tool?: string;
        text?: string;
    }) => {
        state.latest = event.tool === undefined
            ? event.text?.slice(0, 120) ?? event.type
            : `${event.type}: ${event.tool}`;
    });
    vera.experimentalTui.events.on("conversation_changed", () => {
        state.count = 0;
        state.overlayOpen = false;
        void persist();
    });
    vera.experimentalTui.mount({
        id: "review-panel",
        slot: "transcript-bottom",
        title: "Review room",
        focusable: true,
        render: ({ theme }) => ({
            kind: "stack",
            direction: "column",
            gap: 1,
            children: [
                {
                    kind: "text",
                    text: `Notes ${state.count} · ${state.latest}`,
                    tone: "muted",
                },
                { kind: "rule", tone: "muted" },
                {
                    kind: "stack",
                    direction: "row",
                    gap: 1,
                    children: [
                        {
                            kind: "button",
                            label: "Add note",
                            action: "increment",
                            tone: "accent",
                        },
                        {
                            kind: "button",
                            label: state.overlayOpen ? "Close details" : "Details",
                            action: "toggle-overlay",
                            tone: theme.text === "" ? "muted" : "text",
                        },
                    ],
                },
            ],
        }),
        keybindings: [
            { keys: ["ctrl+shift+r"], action: "increment" },
            { keys: ["ctrl+shift+o"], action: "toggle-overlay" },
        ],
        onAction: async (action: string) => {
            if (action === "increment") state.count += 1;
            if (action === "toggle-overlay") state.overlayOpen = !state.overlayOpen;
            await persist();
        },
    });
    vera.experimentalTui.mount({
        id: "review-overlay",
        slot: "overlay",
        title: "Review details",
        modal: true,
        visible: () => state.overlayOpen,
        render: () => ({
            kind: "stack",
            direction: "column",
            gap: 1,
            children: [
                { kind: "text", text: state.latest, tone: "text" },
                {
                    kind: "button",
                    label: "Close",
                    action: "close",
                    tone: "accent",
                },
            ],
        }),
        keybindings: [{ keys: ["escape"], action: "close" }],
        onAction: (action: string) => {
            if (action === "close") state.overlayOpen = false;
        },
    });
    vera.experimentalTui.mount({
        id: "review-footer",
        slot: "footer",
        render: () => ({
            kind: "text",
            text: `review notes: ${state.count}`,
            tone: "success",
        }),
    });
    vera.experimentalTui.mount({
        id: "review-composer-adornment",
        slot: "composer-adornment",
        render: () => ({
            kind: "text",
            text: `next: @${SECONDARY_ALIAS}`,
            tone: "muted",
        }),
    });

    vera.commands.register({
        name: "review-room",
        description: "Open or message a review critic",
        usage: "/review-room [message]",
        interactive: true,
        acceptsImages: true,
        async run({ argumentsText, workspace, imagePaths, signal }: {
            argumentsText: string;
            workspace: string;
            imagePaths: readonly string[];
            signal: AbortSignal;
        }) {
            const existing = vera.agents.visible().find(
                (agent: { mention?: string }) =>
                    agent.mention === SECONDARY_ALIAS,
            );
            const agentId = existing?.agentId ?? (
                await vera.agents.create({
                    pane: "sidebar",
                    mention: SECONDARY_ALIAS,
                    statusLabel: "review",
                    workspace,
                    approvalMode: "ask",
                    attachmentLifetime: "ephemeral",
                }, signal)
            ).agentId;
            if (existing !== undefined) {
                await vera.agents.open({
                    agentId,
                    pane: "sidebar",
                    mention: SECONDARY_ALIAS,
                    statusLabel: "review",
                    attachmentLifetime: "ephemeral",
                }, signal);
            }
            const text = argumentsText.trim();
            if (text.length > 0 || imagePaths.length > 0) {
                await vera.agents.message({
                    agentId,
                    text,
                    imagePaths,
                }, signal);
            }
        },
    });
}
