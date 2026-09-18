import type { AttachmentRef } from "../../../src/engine/protocol.ts";
import type { IdentifiedTuiAgentClient } from "../agent-client.ts";
import { routeTuiAgentMessage } from "../agent-message-routing.ts";
import type { TuiAgentPane } from "../agent-pane.ts";
import type { TuiCommandCatalogEntry } from "../commands.ts";
import { materializeDroppedImage } from "../dropped-image.ts";
import { isJsonlViewClient } from "../jsonl-view-client.ts";
import { focusActiveSurface, renderCommandSuggestions, renderState, renderStatus, sendCommand } from "../main.ts";
import { hostOwnsPromptQueue, setSidebarFocused } from "../main/agents-dials.ts";
import { workerFreeAction } from "../main/chrome.ts";
import { hostedAgentAddressing } from "../main/sidebar-pane.ts";
import { submitPrompt } from "../main/submit-prompt.ts";
import { appendTuiNotice, beginTuiTurn, queueTuiPrompt, userEntryShows } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function leaveJsonlCommandMode(rt: TuiRuntime): void {
    rt.jsonlCommandMode = false;
    rt.composer.clearComposer();
    renderCommandSuggestions(rt);
    renderState(rt);
    focusActiveSurface(rt);
}

export function refuseJsonlCommand(rt: TuiRuntime): void {
    rt.state = appendTuiNotice(
        rt.state,
        "This conversation is idle. Only /resume, /clear, /help, and /theme work until it wakes; press enter to carry on.",
    );
    leaveJsonlCommandMode(rt);
}

export function availableCommandSuggestions(rt: TuiRuntime, 
    input: string,
): readonly TuiCommandCatalogEntry[] {
    const suggestions = rt.commandRegistry.suggestions(input);
    return isJsonlViewClient(rt.client) && rt.jsonlCommandMode
        ? suggestions.filter((entry) =>
            workerFreeAction(rt, 
                rt.commandRegistry.dispatch(`/${entry.name}`),
                true,
            ))
        : suggestions;
}

export function availableCommandCompletion(rt: TuiRuntime, input: string): string | undefined {
    if (!(isJsonlViewClient(rt.client) && rt.jsonlCommandMode)) {
        return rt.commandRegistry.completion(input);
    }
    const suggestions = availableCommandSuggestions(rt, input);
    return suggestions.length === 1
        ? `/${suggestions[0]!.name}`
        : undefined;
}

export function routeVisibleAgentPrompt(rt: TuiRuntime, prompt: string): boolean {
    const side = rt.hostedSidebar.pane;
    if (side === undefined || rt.client.agentId === undefined) return false;
    const route = routeTuiAgentMessage(
        prompt,
        rt.sidebar.isFocused() ? "sidebar" : "main",
        [
            { agentId: rt.client.agentId, pane: "main" },
            {
                agentId: side.agentId,
                pane: "sidebar",
                mention: rt.hostedSidebar.mention ?? side.agentId,
            },
        ],
        hostedAgentAddressing(rt),
    );
    if (route.kind === "unknown") {
        rt.state = appendTuiNotice(rt.state, `No open agent named @${route.mention}`);
        renderState(rt);
        return true;
    }
    if (route.kind === "focus") {
        setSidebarFocused(rt, route.pane === "sidebar");
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        renderState(rt);
        return true;
    }
    const sendsToSidebar = route.targets.some(
        (target) => target.pane === "sidebar",
    );
    const sendsToMain = route.targets.some((target) => target.pane === "main");
    if (sendsToSidebar) {
        const submittedImages = [...rt.pendingImages];
        const imagePaths = rt.pendingImages.flatMap((image) =>
            image.path === undefined ? [] : [image.path]
        );
        if (imagePaths.length !== rt.pendingImages.length) {
            rt.state = appendTuiNotice(
                rt.state,
                "Every sidebar image needs a readable source path",
            );
            renderState(rt);
            return true;
        }
        const controller = new AbortController();
        rt.sidebarPromptSubmitting = true;
        void attachImagesToSidebar(rt, side, imagePaths, controller.signal)
            .then(async (attachments) => {
                if (rt.shuttingDown) return;
                await side.client.send({
                    type: "prompt",
                    content: route.text,
                    ...(attachments.length === 0
                        ? {}
                        : {
                            attachmentIds: attachments.map(
                                (attachment) => attachment.id,
                            ),
                        }),
                });
                const queueing = side.state.state.working
                    || side.state.state.queuedPrompts.length > 0;
                if (
                    !userEntryShows(
                        side.state.state.entries.at(-1),
                        route.text,
                        attachments,
                    )
                ) {
                    side.state.state = queueing
                        ? hostOwnsPromptQueue(rt, side.client)
                            ? side.state.state
                            : queueTuiPrompt(side.state.state, route.text)
                        : beginTuiTurn(
                            side.state.state,
                            route.text,
                            attachments,
                        );
                } else if (!queueing) {
                    side.state.state = {
                        ...side.state.state,
                        working: true,
                    };
                }
                if (!queueing) {
                    side.state.workingSince ??= Date.now();
                    side.state.phaseSince ??= side.state.workingSince;
                    side.state.activity = "thinking";
                }
                if (sendsToMain) {
                    rt.sidebarPromptSubmitting = false;
                    submitPrompt(rt, route.text);
                    return;
                }
                if (rt.shuttingDown) return;
                if (rt.composer.expandedText().trim() === prompt) {
                    rt.composer.rememberSubmittedText(prompt);
                    rt.composer.clearComposer();
                }
                const sent = new Set(
                    submittedImages.map((image) => image.requestId),
                );
                rt.pendingImages = rt.pendingImages.filter(
                    (image) => !sent.has(image.requestId),
                );
            })
            .catch((error) => {
                side.state.state = {
                    ...side.state.state,
                    working: false,
                };
                side.state.workingSince = undefined;
                side.state.phaseSince = undefined;
                rt.state = appendTuiNotice(
                    rt.state,
                    error instanceof Error ? error.message : String(error),
                );
                renderState(rt);
            }).finally(() => {
                rt.sidebarPromptSubmitting = false;
                renderState(rt);
            });
        return true;
    }
    if (sendsToMain && route.text === prompt) return false;
    if (sendsToMain) {
        submitPrompt(rt, route.text);
        return true;
    }
    rt.composer.rememberSubmittedText(prompt);
    rt.composer.clearComposer();
    rt.pendingImages = [];
    renderCommandSuggestions(rt);
    renderState(rt);
    return true;
}

export async function attachImagesToSidebar(rt: TuiRuntime, 
    side: TuiAgentPane<IdentifiedTuiAgentClient>,
    imagePaths: readonly string[],
    signal: AbortSignal,
): Promise<readonly AttachmentRef[]> {
    return Promise.all(imagePaths.map((path) =>
        side.attachImage(randomUUID(), path, signal)
    ));
}

export function offerMessageToExtensions(rt: TuiRuntime, prompt: string): void {
    rt.messageInterceptPending = true;
    renderStatus(rt);
    void rt.clientExtensionRegistry!.interceptMessage({
        text: prompt,
        workspace: rt.client.workspace ?? process.cwd(),
        imageCount: rt.pendingImages.length,
    }).then((decision) => {
        rt.messageInterceptPending = false;
        if (rt.shuttingDown) return;
        if (decision.kind === "handled") {
            if (rt.composer.expandedText().trim() === prompt) {
                rt.composer.rememberSubmittedText(prompt);
                rt.composer.clearComposer();
            }
            renderState(rt);
            return;
        }
        submitPrompt(rt, 
            decision.kind === "replace" ? decision.text : prompt,
            decision.kind === "replace" ? decision.injectedPrefix : undefined,
        );
    }).catch((error) => {
        rt.messageInterceptPending = false;
        if (rt.shuttingDown) return;
        rt.state = appendTuiNotice(
            rt.state,
            error instanceof Error ? error.message : String(error),
        );
        renderState(rt);
    });
}

export function attachPastedImage(rt: TuiRuntime, path: string): void {
    const requestId = randomUUID();
    rt.pendingImages.push({ requestId, path });
    rt.composer.attachImageChip(requestId);
    renderState(rt);
    void materializeDroppedImage(path).then(({ path: taken, release }) => {
        if (!rt.pendingImages.some((image) => image.requestId === requestId)) {
            void release();
            return;
        }
        rt.droppedImageReleases.set(requestId, release);
        sendCommand(rt, { type: "attach_image", requestId, path: taken });
    });
}

export function releaseDroppedImage(rt: TuiRuntime, requestId: string): void {
    const release = rt.droppedImageReleases.get(requestId);
    if (release === undefined) return;
    rt.droppedImageReleases.delete(requestId);
    void release();
}
