import type { SessionEndpoint } from "./session-endpoint.ts";
import type { ControlPeer } from "./control.ts";

const METHODS = {
    setSessionTitle: true, sendToSession: true, askSession: true, investigate: true,
    peerRoster: true, peerSend: true, peerLabel: true, messageSubagent: true,
    closeSubagent: true, notifyParent: true, deliverCompletion: true,
    completionFailure: true, childApproval: true, parentClosing: true,
    canonicalPath: true, inspect: true, residentAt: true, resident: true, residents: true,
    tree: true, find: true, create: true, resume: true, release: true, list: true,
    rememberStored: true, forgetStored: true, rename: true, trash: true,
    reserveTrash: true, quiesceClose: true, waitClose: true, finishCloseMember: true,
    forgetClose: true, canClose: true, recordClosedMembers: true, moveTrashArtifact: true,
    restartTrashMember: true, abandonTrashRestart: true, recordTrashOutcome: true,
    releaseTrash: true, close: true, block: true, unblock: true, sync: true,
    branchSyncInfo: true, branchSourceReady: true, branchSyncDelta: true,
    applyBranchSync: true, facts: true, search: true, searchShard: true, flush: true,
    pumpInbox: true, snapshot: true, workSchedules: true, importSession: true,
    listImportableSessions: true, importedSourceHash: true, suppressCompletion: true,
    cut: true, stopWaitTargets: true, runningSubagents: true, parkFacts: true,
    blockHasSession: true, blockTreeShard: true, blockAbort: true, blockConfirm: true,
    blockWrite: true, blockedIds: true, blockRemove: true, blockRelease: true,
} satisfies Record<keyof SessionEndpoint, true>;

export function remoteSessionEndpoint(connection: ControlPeer | Promise<ControlPeer> | (() => Promise<ControlPeer>)): SessionEndpoint {
    const connected = typeof connection === "function" ? connection : () => Promise.resolve(connection);
    const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of Object.keys(METHODS)) {
        methods[method] = (...args) => {
            const signal = method === "askSession" || method === "investigate"
                ? args.pop() as AbortSignal : undefined;
            return connected().then((peer) => peer.request(`session.${method}`, args, signal));
        };
    }
    return methods as unknown as SessionEndpoint;
}

export async function serveSessionEndpoint(
    endpoint: SessionEndpoint, method: string, args: readonly unknown[], signal: AbortSignal,
): Promise<unknown> {
    if (!Object.hasOwn(METHODS, method)) throw new Error("Unknown session control request");
    const invoke = endpoint[method as keyof SessionEndpoint] as (...values: unknown[]) => Promise<unknown>;
    return await invoke.apply(endpoint, method === "askSession" || method === "investigate" ? [...args, signal] : [...args]);
}
