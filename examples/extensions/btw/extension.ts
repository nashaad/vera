const SIDEKICK = "sidekick";

/** `/btw` is policy; Vera owns hosted agents, attachment, and rendering. */
export function activateClient(vera: any): void {
    let agentId: string | undefined;

    function offerVisibleMentions(): void {
        vera.ui.mentions.set(
            agentId === undefined ? [] : [SIDEKICK, "all", "vera"],
        );
    }

    async function openSidekick(
        workspace: string,
        signal: AbortSignal,
    ): Promise<string> {
        if (agentId === undefined) {
            const created = await vera.agents.create({
                pane: "sidebar",
                workspace,
                approvalMode: "readonly",
            }, signal);
            agentId = created.agentId;
            offerVisibleMentions();
            return created.agentId;
        }
        await vera.agents.open({ agentId, pane: "sidebar" }, signal);
        return agentId;
    }

    vera.commands.register({
        name: "btw",
        description: "Open or message a readonly sidekick",
        usage: "/btw [message]",
        interactive: true,
        async run({ argumentsText, workspace, signal }: {
            argumentsText: string;
            workspace: string;
            signal: AbortSignal;
        }) {
            const target = await openSidekick(workspace, signal);
            const text = argumentsText.trim();
            if (text.length > 0) {
                await vera.agents.message({ agentId: target, text }, signal);
            }
        },
    });

    vera.conversation.onChanged(() => {
        agentId = undefined;
        offerVisibleMentions();
    });

    offerVisibleMentions();
}
