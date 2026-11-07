import { existsSync } from "node:fs";
import { join } from "node:path";

import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { BlockSessionOutcome, UnblockSessionOutcome } from "../../src/host/server.ts";
import {
    listSessionBlocks,
    readSessionBlock,
    removeSessionBlock,
    startedTreeOf,
    writeSessionBlock,
    type SessionBlockRecord,
    type StoredSessionTree,
} from "../../src/host/session-block.ts";
import { resolveAgentIdentifier } from "./agent-id.ts";

export interface SessionBlockCommandDependencies {
    readonly listLive: () => Promise<readonly RegisteredAgentSummary[]>;
    readonly readStored: () => Promise<StoredSessionTree>;
    readonly sessionDirectory: string;
    readonly blockedDirectory: string;
    readonly hostSocketPath: () => Promise<string | undefined>;
    readonly blockThroughHost: (
        socketPath: string,
        request: {
            readonly targetAgentId: string;
            readonly sessionIds: readonly string[];
            readonly reason: string | null;
        },
    ) => Promise<BlockSessionOutcome>;
    readonly unblockThroughHost: (
        socketPath: string,
        request: {
            readonly targetAgentId: string;
            readonly sessionIds: readonly string[];
        },
    ) => Promise<UnblockSessionOutcome>;
    readonly hasTerminal: boolean;
    readonly confirm: (question: string) => Promise<boolean>;
    readonly output: { write(text: string): unknown };
    readonly errorOutput: { write(text: string): unknown };
    readonly now?: () => Date;
}

interface SessionRow {
    readonly id: string;
    readonly name: string | undefined;
    readonly live: boolean;
}

const MAX_REASON_LENGTH = 500;

export async function runBlockCommand(
    args: readonly string[],
    deps: SessionBlockCommandDependencies,
): Promise<number> {
    const parsed = parseArgs(args, "block");
    if (parsed.status === "usage") {
        deps.errorOutput.write(`${parsed.message}\n`);
        return 1;
    }
    if (!deps.hasTerminal) {
        deps.errorOutput.write("vera block needs a terminal to confirm.\n");
        return 1;
    }
    const live = await deps.listLive();
    const target = await resolveTarget(parsed.id, live, deps);
    if (target === undefined) {
        deps.errorOutput.write(
            `Could not block ${parsed.id}: no agent or session has that id. `
            + `Run 'vera ls --all' to see them.\n`,
        );
        return 1;
    }
    const stored = await deps.readStored();
    const tree = treeRows(target.id, live, stored);
    const reasonText = parsed.reason === null ? "" : ` Reason: ${parsed.reason}.`;
    deps.output.write(
        `Blocking ${blockTargetText(target.label, tree.length)}.${reasonText}\n`
        + renderRows(tree)
        + `Turns in these sessions stop, and nothing new starts in them until `
        + `'vera unblock ${target.id}'.\n`,
    );
    const approved = await deps.confirm(
        `Block ${tree.length} session${tree.length === 1 ? "" : "s"}? [y/N] `,
    );
    if (!approved) {
        deps.errorOutput.write("Not blocked.\n");
        return 1;
    }
    const ids = tree.map((row) => row.id);
    const socketPath = await deps.hostSocketPath();
    if (socketPath !== undefined) {
        const outcome = await deps.blockThroughHost(socketPath, {
            targetAgentId: target.id,
            sessionIds: ids,
            reason: parsed.reason,
        });
        if (outcome.status === "rejected") {
            deps.errorOutput.write(
                `Could not block ${target.label}: the host could not complete the block.\n`,
            );
            return 1;
        }
        deps.output.write(blockedText(target.label, outcome.sessionIds.length));
        return 0;
    }
    // No host is running, so nothing is running either; the flags alone are the block.
    const blockedAt = (deps.now ?? (() => new Date()))().toISOString();
    for (const id of ids) {
        const record: SessionBlockRecord = {
            version: 1,
            session_id: id,
            root_session_id: target.id,
            blocked_at: blockedAt,
            reason: parsed.reason,
        };
        await writeSessionBlock(deps.blockedDirectory, record);
    }
    deps.output.write(blockedText(target.label, ids.length));
    return 0;
}

export async function runUnblockCommand(
    args: readonly string[],
    deps: SessionBlockCommandDependencies,
): Promise<number> {
    const parsed = parseArgs(args, "unblock");
    if (parsed.status === "usage") {
        deps.errorOutput.write(`${parsed.message}\n`);
        return 1;
    }
    if (!deps.hasTerminal) {
        deps.errorOutput.write("vera unblock needs a terminal to confirm.\n");
        return 1;
    }
    const state = await readSessionBlock(deps.blockedDirectory, parsed.id);
    if (state.status === "absent") {
        deps.errorOutput.write(`Session ${parsed.id} is not blocked.\n`);
        return 1;
    }
    const root = state.status === "blocked"
        ? state.record.root_session_id
        : parsed.id;
    const records = await listSessionBlocks(deps.blockedDirectory);
    const group = records.filter((record) => record.root_session_id === root);
    const groupIds = group.map((record) => record.session_id);
    if (!groupIds.includes(parsed.id)) groupIds.unshift(parsed.id);
    const live = await deps.listLive();
    const stored = await deps.readStored();
    const rows = groupIds.map((id) => rowFor(id, live, stored));
    deps.output.write(
        `Unblocking ${groupIds.length} session${groupIds.length === 1 ? "" : "s"} `
        + `blocked with ${parsed.id}.\n`
        + renderRows(rows),
    );
    const approved = await deps.confirm(
        `Unblock ${groupIds.length} session${groupIds.length === 1 ? "" : "s"}? [y/N] `,
    );
    if (!approved) {
        deps.errorOutput.write("Not unblocked.\n");
        return 1;
    }
    const socketPath = await deps.hostSocketPath();
    if (socketPath !== undefined) {
        const outcome = await deps.unblockThroughHost(socketPath, {
            targetAgentId: parsed.id,
            sessionIds: groupIds,
        });
        if (outcome.status === "rejected") {
            deps.errorOutput.write(
                `Could not unblock ${parsed.id}: the host could not complete the unblock.\n`,
            );
            return 1;
        }
        deps.output.write(`Unblocked ${outcome.sessionIds.length} session(s).\n`);
        return 0;
    }
    for (const id of groupIds) {
        await removeSessionBlock(deps.blockedDirectory, id);
    }
    deps.output.write(`Unblocked ${groupIds.length} session(s).\n`);
    return 0;
}

type ParsedArgs =
    | { readonly status: "ok"; readonly id: string; readonly reason: string | null }
    | { readonly status: "usage"; readonly message: string };

function parseArgs(args: readonly string[], command: "block" | "unblock"): ParsedArgs {
    const usage = {
        status: "usage" as const,
        message: `${command} needs the id of a live agent or session. `
            + `Run 'vera ls --all' to see them, then 'vera ${command} <agent-id>'.`,
    };
    let id: string | undefined;
    let reason: string | null = null;
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index]!;
        if (token === "--reason" && command === "block") {
            const value = rest[index + 1];
            if (value === undefined || value.startsWith("--")) return usage;
            if (value.length === 0 || value.length > MAX_REASON_LENGTH
                || /[\u0000-\u001f]/u.test(value)) {
                return {
                    status: "usage",
                    message: `--reason needs one line of text, up to ${MAX_REASON_LENGTH} characters.`,
                };
            }
            reason = value;
            index += 1;
            continue;
        }
        if (id !== undefined || token.startsWith("-") || token.length === 0) {
            return usage;
        }
        id = token;
    }
    return id === undefined ? usage : { status: "ok", id, reason };
}

async function resolveTarget(
    input: string,
    live: readonly RegisteredAgentSummary[],
    deps: SessionBlockCommandDependencies,
): Promise<{ readonly id: string; readonly label: string } | undefined> {
    const resolution = resolveAgentIdentifier(input, live);
    if (resolution.status === "ambiguous") {
        deps.errorOutput.write(
            `Could not block ${input}: more than one agent matches. `
            + `Name one of ${resolution.candidates.join(", ")}.\n`,
        );
        return undefined;
    }
    const stored = await deps.readStored();
    const known = live.some((agent) => agent.id === resolution.id)
        || stored.names.has(resolution.id)
        || stored.parents.has(resolution.id)
        || (await readSessionBlock(deps.blockedDirectory, resolution.id)).status !== "absent"
        || sessionFileExists(deps.sessionDirectory, resolution.id);
    return known ? { id: resolution.id, label: resolution.label } : undefined;
}

function treeRows(
    rootId: string,
    live: readonly RegisteredAgentSummary[],
    stored: StoredSessionTree,
): readonly SessionRow[] {
    const parents = new Map(stored.parents);
    for (const agent of live) {
        if (agent.parent_id !== undefined) parents.set(agent.id, agent.parent_id);
    }
    return startedTreeOf(rootId, parents).map((id) => rowFor(id, live, stored));
}

function rowFor(
    id: string,
    live: readonly RegisteredAgentSummary[],
    stored: StoredSessionTree,
): SessionRow {
    const agent = live.find((entry) => entry.id === id);
    return {
        id,
        name: agent?.name ?? agent?.title ?? stored.names.get(id),
        live: agent?.live === true,
    };
}

function renderRows(rows: readonly SessionRow[]): string {
    return rows.map((row) => {
        const name = row.name === undefined ? "" : `  ${row.name}`;
        return `  ${row.id}  ${row.live ? "live" : "not live"}${name}\n`;
    }).join("");
}

function blockedText(label: string, count: number): string {
    return `Blocked ${blockTargetText(label, count)}. `
        + `Nothing new runs in ${count === 1 ? "it" : "them"} until unblocked.\n`;
}

// Counts the target and the sessions it started.
function blockTargetText(label: string, count: number): string {
    return count === 1
        ? label
        : `${label} and ${count - 1} session${count === 2 ? "" : "s"} it started`;
}

function sessionFileExists(directory: string, id: string): boolean {
    return existsSync(join(directory, `${id}.jsonl`));
}
