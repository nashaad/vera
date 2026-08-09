const SIDEKICK = "sidekick";
const PEER = "peer";

/** These commands are policy; Vera owns hosted agents, attachment, and rendering. */
export function activateClient(vera: any): void {
    const agents: Record<string, string | undefined> = {};
    let activeMention: string | undefined;

    function offerVisibleMentions(): void {
        vera.ui.mentions.set(
            activeMention === undefined ? [] : [activeMention, "all", "vera"],
        );
    }

    async function openAgent(
        mention: string,
        approvalMode: "readonly" | "ask",
        workspace: string,
        signal: AbortSignal,
    ): Promise<string> {
        let agentId = agents[mention];
        if (agentId === undefined) {
            const created = await vera.agents.create({
                pane: "sidebar",
                mention,
                workspace,
                approvalMode,
            }, signal);
            agentId = created.agentId;
            agents[mention] = agentId;
        } else {
            await vera.agents.open({
                agentId,
                pane: "sidebar",
                mention,
            }, signal);
        }
        activeMention = mention;
        offerVisibleMentions();
        return agentId;
    }

    function register(
        name: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        description: string,
    ): void {
        vera.commands.register({
            name,
            description,
            usage: `/${name} [message]`,
            interactive: true,
            async run({ argumentsText, workspace, signal }: {
                argumentsText: string;
                workspace: string;
                signal: AbortSignal;
            }) {
                const target = await openAgent(
                    mention,
                    approvalMode,
                    workspace,
                    signal,
                );
                const text = argumentsText.trim();
                if (text.length > 0) {
                    await vera.agents.message({ agentId: target, text }, signal);
                }
            },
        });
    }

    register("btw", SIDEKICK, "readonly", "Open or message a readonly sidekick");
    register("pair", PEER, "ask", "Open or message a tool-capable peer");

    vera.conversation.onChanged(() => {
        agents[SIDEKICK] = undefined;
        agents[PEER] = undefined;
        activeMention = undefined;
        offerVisibleMentions();
    });

    offerVisibleMentions();
}
