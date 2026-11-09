import type { AttachmentCoordinator } from "../attachment-coordinator.ts";
import type { HostRouter } from "./router.ts";
import type { ControlChannel } from "./control.ts";

type WorkerRouter = Pick<HostRouter,
    "setSessionTitle" | "sendToSession" | "askSession" | "investigate"
    | "peerRoster" | "peerSend" | "peerLabel" | "messageSubagent" | "closeSubagent"
    | "notifyParent" | "deliverCompletion" | "completionFailure" | "childApproval"
    | "parentClosing" | "reserveSubagentStart" | "releaseSubagentStart"
    | "beginBranch" | "endBranch" | "socketFor" | "pumpInbox" | "importedSourceHash"
    | "beginWorkerCreate" | "endWorkerOpen"
>;

const ROUTER_METHODS = {
    setSessionTitle: true, sendToSession: true, askSession: true, investigate: true,
    peerRoster: true, peerSend: true, peerLabel: true, messageSubagent: true,
    closeSubagent: true, notifyParent: true, deliverCompletion: true, completionFailure: true,
    childApproval: true, parentClosing: true, reserveSubagentStart: true, releaseSubagentStart: true,
    beginBranch: true, endBranch: true, socketFor: true, pumpInbox: true, importedSourceHash: true,
    beginWorkerCreate: true, endWorkerOpen: true,
} satisfies Record<keyof WorkerRouter, true>;

const ATTACHMENT_METHODS = {
    open: true, detach: true, abandon: true, ready: true, release: true, closeIfReady: true,
} satisfies Record<keyof AttachmentCoordinator, true>;

export function remoteRouter(peer: ControlChannel): WorkerRouter {
    return remoteMethods(peer, "router", ROUTER_METHODS) as unknown as WorkerRouter;
}

export function remoteAttachments(peer: ControlChannel): AttachmentCoordinator {
    return remoteMethods(peer, "attachment", ATTACHMENT_METHODS) as unknown as AttachmentCoordinator;
}

function remoteMethods(peer: ControlChannel, prefix: string, names: Record<string, true>) {
    const result: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of Object.keys(names)) {
        result[method] = (...args) => {
            const signal = method === "askSession" || method === "investigate"
                ? args.pop() as AbortSignal : undefined;
            return peer.request(`${prefix}.${method}`, args, signal);
        };
    }
    return result;
}

export async function serveRoutedMethod(
    target: HostRouter | AttachmentCoordinator, kind: "router" | "attachment",
    method: string, args: readonly unknown[], signal: AbortSignal,
): Promise<unknown> {
    const allowed = kind === "router" ? ROUTER_METHODS : ATTACHMENT_METHODS;
    if (!Object.hasOwn(allowed, method)) throw new Error("Unknown routed control request");
    const invoke = (target as unknown as Record<string, (...values: unknown[]) => unknown>)[method]!;
    const values = method === "beginWorkerCreate"
        ? [args[0], args[1], args[2], args[3], signal]
        : method === "askSession" || method === "investigate" ? [...args, signal] : [...args];
    return await invoke.apply(target, values);
}
