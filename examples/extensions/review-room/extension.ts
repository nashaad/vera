const SECONDARY_ALIAS = "critic";

/** A deliberately different experimental hosted-agent client extension. */
export function activateClient(vera: any): void {
    vera.agents.declareExperimentalAddressing({
        primary: "author",
        secondary: SECONDARY_ALIAS,
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
