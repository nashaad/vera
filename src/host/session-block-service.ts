import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentRegistry } from "./agent-registry.ts";
import type { SessionBlockControl } from "./agent-registry/support.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "./server.ts";
import type { BlockSessionRequest, UnblockSessionRequest } from "./protocol.ts";
import {
    readSessionBlock,
    readStoredSessionTree,
    readStoredSessionTreeShard,
    removeSessionBlock,
    startedTreeOf,
    writeSessionBlock,
    type SessionBlockRecord,
    type StoredSessionTreeRow,
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
    hasSession(id: string): boolean;
    treeShard(includePaths?: readonly string[], excludePaths?: readonly string[]): Promise<readonly StoredSessionTreeRow[]>;
    abort(ids: readonly string[]): Promise<void>;
    confirm(ids: readonly string[]): Promise<void>;
    write(request: BlockSessionRequest, ids: readonly string[]): Promise<boolean>;
    blocked(ids: readonly string[]): Promise<readonly string[]>;
    remove(ids: readonly string[]): Promise<readonly string[]>;
    release(ids: readonly string[]): Promise<readonly string[]>;
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

    async function writeBlocks(request: BlockSessionRequest, ids: readonly string[]): Promise<boolean> {
        try {
            const blockedAt = now().toISOString();
            for (const id of ids) {
                const record: SessionBlockRecord = {
                    version: 1, session_id: id, root_session_id: request.target_agent_id,
                    blocked_at: blockedAt, reason: request.reason,
                };
                await writeSessionBlock(options.blockedDirectory, record);
            }
            return true;
        } catch {
            return false;
        }
    }

    async function blocked(ids: readonly string[]): Promise<readonly string[]> {
        const result: string[] = [];
        for (const id of ids) {
            if ((await readSessionBlock(options.blockedDirectory, id)).status !== "absent") result.push(id);
        }
        return result;
    }

    async function remove(ids: readonly string[]): Promise<readonly string[]> {
        const result: string[] = [];
        for (const id of ids) if (await removeSessionBlock(options.blockedDirectory, id)) result.push(id);
        return result;
    }

    async function release(ids: readonly string[]): Promise<readonly string[]> {
        const unconfirmed: string[] = [];
        for (const id of ids) {
            const control = blockControlOf(id);
            if (control !== undefined && !(await control.releaseBlock(BLOCK_ACK_TIMEOUT_MS))) unconfirmed.push(id);
        }
        return unconfirmed;
    }

    return {
        hasSession: (id) => options.registry.agents.has(id) || existsSync(join(options.sessionDirectory, `${id}.jsonl`)),
        treeShard: (include, exclude) => readStoredSessionTreeShard(options.sessionDirectory, include, exclude),
        abort: abortLive,
        confirm: confirmLive,
        write: writeBlocks,
        blocked,
        remove,
        release,
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
            if (!await writeBlocks(request, tree)) {
                await abortLive(tree);
                return { status: "rejected", reason: "failed" };
            }
            await confirmLive(tree);
            await abortLive(tree);
            return { status: "blocked", sessionIds: tree };
        },

        async unblock(request) {
            const held = await blocked(request.session_ids);
            if (held.length === 0) {
                return { status: "rejected", reason: "not_found" };
            }
            // The latch must hold before the flag goes, or a worker that never saw the flag could start its queue.
            await confirmLive(held);
            const removed = await remove(held);
            const unconfirmed = await release(removed);
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
