import type { MoveSessionOutcome } from "../../ui/src/protocol/sessionMove.ts";

// The host's moveSessionThroughHost; passing it where this type is expected fails to compile if the host adds a reason.
export type MoveThroughHost = (socketPath: string, sessionId: string, workspace: string) => Promise<MoveSessionOutcome>;

export interface SessionMoveRequest {
    // Undefined while the window has no host.
    readonly socketPath: string | undefined;
    readonly sessionId: string;
    // The folder the person picked; undefined when they cancelled.
    readonly chooseFolder: () => Promise<string | undefined>;
    readonly move: MoveThroughHost;
}

const FAILED: MoveSessionOutcome = { status: "rejected", reason: "failed" };

// The picker opens only when there is a host to ask, and a cancelled picker sends nothing.
export async function moveSessionToFolder(request: SessionMoveRequest): Promise<MoveSessionOutcome> {
    if (request.socketPath === undefined) return FAILED;
    let folder: string | undefined;
    try {
        folder = await request.chooseFolder();
    } catch {
        return FAILED;
    }
    if (folder === undefined || folder.length === 0) return { status: "cancelled" };
    return request.move(request.socketPath, request.sessionId, folder);
}
