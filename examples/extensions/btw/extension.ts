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
        statusLabel: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        attachmentLifetime: "ephemeral" | "durable",
        workspace: string,
        signal: AbortSignal,
    ): Promise<string> {
        let agentId = agents[mention]
            ?? vera.agents.visible().find((agent: { mention?: string }) =>
                agent.mention === mention
            )?.agentId;
        if (agentId === undefined) {
            const created = await vera.agents.create({
                pane: "sidebar",
                mention,
                statusLabel,
                workspace,
                approvalMode,
                attachmentLifetime,
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
        offerVisibleMentions();
        return agentId;
    }

    function register(
        name: string,
        mention: string,
        approvalMode: "readonly" | "ask",
        attachmentLifetime: "ephemeral" | "durable",
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
        "Open or message a readonly sidekick",
    );
    register(
        "pair",
        PEER,
        "ask",
        "durable",
        "Open or message a tool-capable peer",
    );

    vera.conversation.onChanged(() => {
        agents[SIDEKICK] = undefined;
        agents[PEER] = undefined;
        activeMention = undefined;
        offerVisibleMentions();
    });

    offerVisibleMentions();
}
