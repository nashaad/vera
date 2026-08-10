import { randomUUID } from "node:crypto";

import type {
    ClientExtensionAgentsAdapter,
} from "../../src/extensions/client-registry.ts";
import type { TuiAgentPane } from "./agent-pane.ts";
import {
    requireIdentifiedTuiAgentClient,
    type IdentifiedTuiAgentClient,
    type TuiAgentClient,
} from "./agent-client.ts";

export interface TuiClientExtensionAgentsOptions {
    primary(): TuiAgentClient;
    sidebar(): TuiAgentPane<IdentifiedTuiAgentClient> | undefined;
    sidebarMention(): string | undefined;
    createAgent?: (
        workspace: string,
        approvalMode?: string,
        attachmentLifetime?: "ephemeral" | "durable",
    ) => Promise<TuiAgentClient>;
    branchAgent?: (
        sourceAgentId: string,
        approvalMode: string | undefined,
        attachmentLifetime: "ephemeral" | "durable" | undefined,
        signal: AbortSignal,
    ) => Promise<TuiAgentClient>;
    attachAgent?: (agentId: string) => Promise<TuiAgentClient>;
    /** Assumes ownership of client immediately, including on rejection. */
    adoptAgent(
        extensionId: string,
        client: IdentifiedTuiAgentClient,
        pane: "main" | "sidebar",
        mention: string | undefined,
        attachmentLifetime: "ephemeral" | "durable" | undefined,
        initialApprovalMode: string | undefined,
        statusLabel: string | undefined,
        signal: AbortSignal,
    ): Promise<void>;
}

export function createTuiClientExtensionAgentsAdapter(
    options: TuiClientExtensionAgentsOptions,
): ClientExtensionAgentsAdapter {
    return {
        visible() {
            const primary = options.primary();
            const sidebar = options.sidebar();
            const sidebarMention = options.sidebarMention();
            return [
                ...(primary.agentId === undefined
                    ? []
                    : [{ agentId: primary.agentId, pane: "main" as const }]),
                ...(sidebar === undefined
                    ? []
                    : [{
                        agentId: sidebar.agentId,
                        pane: "sidebar" as const,
                        ...(sidebarMention === undefined
                            ? {}
                            : { mention: sidebarMention }),
                    }]),
            ];
        },
        async create(extensionId, request, signal) {
            signal.throwIfAborted();
            const primary = options.primary();
            const source = request.source;
            if (
                source !== undefined
                && !this.visible(extensionId).some((agent) =>
                    agent.agentId === source.agentId
                )
            ) {
                throw new Error("Extensions can branch only a visible agent");
            }
            const next = requireIdentifiedTuiAgentClient(await (
                source === undefined
                    ? options.createAgent === undefined
                        ? Promise.reject(new Error("This client cannot create agents"))
                        : options.createAgent(
                            request.workspace ?? primary.workspace ?? process.cwd(),
                            request.approvalMode,
                            request.attachmentLifetime,
                        )
                    : options.branchAgent === undefined
                        ? Promise.reject(new Error("This client cannot branch agents"))
                        : options.branchAgent(
                            source.agentId,
                            request.approvalMode,
                            request.attachmentLifetime,
                            signal,
                        )
            ));
            if (signal.aborted) {
                next.close();
                throw signal.reason;
            }
            await options.adoptAgent(
                extensionId,
                next,
                request.pane,
                request.mention,
                request.attachmentLifetime,
                request.approvalMode,
                request.statusLabel,
                signal,
            );
            return { agentId: next.agentId };
        },
        async open(extensionId, request, signal) {
            signal.throwIfAborted();
            if (options.attachAgent === undefined) {
                throw new Error("This client cannot attach agents");
            }
            const next = requireIdentifiedTuiAgentClient(
                await options.attachAgent(request.agentId),
            );
            if (signal.aborted) {
                next.close();
                throw signal.reason;
            }
            await options.adoptAgent(
                extensionId,
                next,
                request.pane,
                request.mention,
                request.attachmentLifetime,
                undefined,
                request.statusLabel,
                signal,
            );
        },
        async message(_extensionId, request, signal) {
            signal.throwIfAborted();
            const visibleSidebar = options.sidebar();
            const sidebar = request.agentId === visibleSidebar?.agentId
                ? visibleSidebar
                : undefined;
            if (sidebar !== undefined) {
                const attachments = await Promise.all(
                    (request.imagePaths ?? []).map((path) =>
                        sidebar.attachImage(randomUUID(), path, signal)
                    ),
                );
                await sidebar.client.send({
                    type: "prompt",
                    content: request.text,
                    ...(attachments.length === 0
                        ? {}
                        : {
                            attachmentIds: attachments.map((attachment) =>
                                attachment.id
                            ),
                        }),
                });
                return;
            }
            const primary = options.primary();
            if (request.agentId !== primary.agentId) {
                throw new Error("Agent must be open before it can be messaged");
            }
            if ((request.imagePaths?.length ?? 0) > 0) {
                throw new Error("Submitted images already belong to the main agent");
            }
            await primary.send({ type: "prompt", content: request.text });
        },
    };
}
