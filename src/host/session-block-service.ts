import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentRegistry } from "./agent-registry.ts";
import type { SessionBlockControl } from "./agent-registry/support.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "./server.ts";
import type { BlockSessionRequest, UnblockSessionRequest } from "./protocol.ts";
import {
    readSessionBlock,
    readStoredSessionTree,
    removeSessionBlock,
    startedTreeOf,
    writeSessionBlock,
    type SessionBlockRecord,
} from "./session-block.ts";

// A worker that does not confirm in time keeps running; the outcome says so.
const BLOCK_ACK_TIMEOUT_MS = 2000;

export interface SessionBlockServiceOptions {
    readonly registry: AgentRegistry;
    readonly sessionDirectory: string;
    readonly blockedDirectory: string;
    readonly now?: () => Date;
}

export interface SessionBlockService {
    block(request: BlockSessionRequest): Promise<BlockSessionOutcome>;
    unblock(request: UnblockSessionRequest): Promise<UnblockSessionOutcome>;
}

export function createSessionBlockService(
    options: SessionBlockServiceOptions,
): SessionBlockService {
    const now = options.now ?? (() => new Date());

    // A live session latches from the flag before the caller goes on; the latch halts its queue at once.
    function blockControlOf(id: string): SessionBlockControl | undefined {
        return options.registry.agents.get(id)?.blockControl;
    }

    async function confirmLive(ids: readonly string[]): Promise<void> {
        await Promise.all(ids.map((id) =>
            blockControlOf(id)?.confirmBlock(BLOCK_ACK_TIMEOUT_MS)
                ?? Promise.resolve(false)
        ));
    }

    async function abortLive(ids: readonly string[]): Promise<void> {
        for (const id of ids) {
            options.registry.agents.get(id)?.agent.abort();
        }
    }

    return {
        async block(request) {
            const root = request.target_agent_id;
            const storedRoot = existsSync(
                join(options.sessionDirectory, `${root}.jsonl`),
            );
            if (!options.registry.agents.has(root) && !storedRoot) {
                return { status: "rejected", reason: "not_found" };
            }
            const stored = await readStoredSessionTree(options.sessionDirectory);
            const parents = new Map(stored.parents);
            for (const [id, entry] of options.registry.agents) {
                if (entry.parentId !== undefined) parents.set(id, entry.parentId);
            }
            const tree = [...new Set([
                ...startedTreeOf(root, parents),
                ...request.session_ids,
            ])];
            // The turns end first; the flags then keep anything queued from starting; the second abort catches a turn that began in between.
            await abortLive(tree);
            try {
                const blockedAt = now().toISOString();
                for (const id of tree) {
                    const record: SessionBlockRecord = {
                        version: 1,
                        session_id: id,
                        root_session_id: root,
                        blocked_at: blockedAt,
                        reason: request.reason,
                    };
                    await writeSessionBlock(options.blockedDirectory, record);
                }
            } catch {
                await abortLive(tree);
                return { status: "rejected", reason: "failed" };
            }
            await confirmLive(tree);
            await abortLive(tree);
            return { status: "blocked", sessionIds: tree };
        },

        async unblock(request) {
            const blocked: string[] = [];
            for (const id of request.session_ids) {
                const state = await readSessionBlock(options.blockedDirectory, id);
                if (state.status === "absent") continue;
                blocked.push(id);
            }
            if (blocked.length === 0) {
                return { status: "rejected", reason: "not_found" };
            }
            // The latch must hold before the flag goes, or a worker that never saw the flag could start its queue.
            await confirmLive(blocked);
            const removed: string[] = [];
            for (const id of blocked) {
                if (await removeSessionBlock(options.blockedDirectory, id)) {
                    removed.push(id);
                }
            }
            const unconfirmed: string[] = [];
            for (const id of removed) {
                const control = blockControlOf(id);
                if (control === undefined) continue;
                if (!(await control.releaseBlock(BLOCK_ACK_TIMEOUT_MS))) {
                    unconfirmed.push(id);
                }
            }
            return removed.length === 0
                ? { status: "rejected", reason: "not_found" }
                : {
                    status: "unblocked",
                    sessionIds: removed,
                    unconfirmedSessionIds: unconfirmed,
                };
        },
    };
}
