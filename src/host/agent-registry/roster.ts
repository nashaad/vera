import { statSync } from "node:fs";
import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import { sessionChangedFiles } from "../../store/preimage-stash.ts";
import type { AgentInboxEffect, AgentSendEffect, AppliedToolEffectOutput, ToolOutput } from "../../tools/types.ts";
import { SOURCE_GAP_KIND } from "../../watch/source.ts";
import { workspaceKey } from "../../workspace-key.ts";
import { MAX_PEER_HOP, MAX_PEER_WAKES_PER_WINDOW, PEER_WAKE_WINDOW_MS, acknowledgeAfterCommit, entryIsLive, entryStatus, entryUpdatedAt, genericInboxResult, importedSessionSummary, gitRosterFacts, normalizeSessionName, sameWorkspace, toolError, type RegisteredAgentEntry, type RegisteredAgentSummary, type RenameSessionOutcome } from "./support.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import type { InboxAdmissionCandidate, InboxAdmissionDecision } from "../inbox-delivery.ts";
import { PEER_MESSAGE_KIND, PEER_READ_KIND, VERA_INBOX_SOURCE, parsePeerMessage, parsePeerRead, type PeerMessagePayload } from "../local-participation.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "../work-index.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export function applyAgentRosterEffect(reg: AgentRegistry, callerId: string, details: boolean): Promise<ToolOutput> {
        const caller = reg.agents.get(callerId);
        if (caller === undefined) {
            return Promise.resolve({
                kind: "output",
                output: "This session is no longer registered with the host.",
                isError: true,
            });
        }
        const here = workspaceKey(caller.agent.workspace);
        const rows = [...reg.agents.entries()]
            .filter(([id, entry]) =>
                id !== callerId
                && workspaceKey(entry.agent.workspace) === here
                && entryStatus(entry) !== "closed"
                && entryStatus(entry) !== "failed"
                && entryStatus(entry) !== "completed"
                && (details || entryIsLive(entry))
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, entry]) => {
                const unread = entry.inbox?.consumer.unreadStatus({
                    limit: 99,
                    addresses: [id],
                    excludeKinds: [SOURCE_GAP_KIND],
                }) ?? { count: 0, oldestAgeMs: null };
                const compact = {
                    participant_id: id,
                    name: entry.identity?.name,
                    status: entryStatus(entry),
                    live: entryIsLive(entry),
                };
                if (!details) return compact;
                return {
                    ...compact,
                    workspace: entry.agent.workspace,
                    workspace_key: workspaceKey(entry.agent.workspace),
                    ...gitRosterFacts(entry.agent.workspace),
                    kind: entry.kind,
                    last_activity: entryUpdatedAt(entry),
                    notice: entry.inbox !== undefined && entry.agent.attached
                        ? "ui"
                        : "none",
                    unread_count: unread.count,
                    oldest_unread_age_ms: unread.oldestAgeMs,
                    session_path: entry.store.path,
                };
            });
        return Promise.resolve({
            kind: "output",
            output: JSON.stringify({
                self_participant_id: callerId,
                participants: rows,
            }),
            isError: false,
        });
    }

export async function applyAgentSendEffect(reg: AgentRegistry, callerId: string, effect: AgentSendEffect): Promise<ToolOutput> {
        const caller = reg.agents.get(callerId);
        const recipient = reg.agents.get(effect.to);
        const inbox = reg.options.inboxDelivery;
        if (caller === undefined || caller.inbox === undefined || inbox === undefined) {
            return toolError("Native inbox participation is unavailable in this session.");
        }
        if (effect.to === callerId) {
            return toolError("agent_send cannot send a message to its own session.");
        }
        if (
            recipient === undefined
            || recipient.kind !== "interactive"
            || recipient.inbox === undefined
            || recipient.agent.closed
            || recipient.agent.failed
        ) {
            return toolError(`No native Vera participant ${effect.to}.`);
        }
        if (!sameWorkspace(caller, recipient)) {
            return toolError("agent_send recipients must be in the same workspace.");
        }
        let replyTo: number | undefined;
        if (effect.replyTo !== undefined) {
            const replied = inbox.entry(effect.replyTo);
            const message = replied === undefined ? undefined : parsePeerMessage(replied);
            const readThrough = caller.inbox.consumer.offset();
            if (!(
                message === undefined
                || message.from !== effect.to
                || message.to !== callerId
                || readThrough < effect.replyTo
            )) {
                replyTo = effect.replyTo;
            }
        }
        const payload: PeerMessagePayload = {
            version: 1,
            from: callerId,
            to: effect.to,
            text: effect.text,
            ...(replyTo === undefined ? {} : { reply_to: replyTo }),
        };
        const recipientLive = entryIsLive(recipient);
        const notice = recipient.agent.attached ? "ui" as const : "none" as const;
        const stored = await inbox.append({
            source: VERA_INBOX_SOURCE,
            kind: PEER_MESSAGE_KIND,
            actor: callerId,
            session: callerId,
            address: effect.to,
            payload: JSON.stringify(payload),
        });
        const delivery = inbox.hasAdmissionPath()
            ? recipient.agent.attached
                && recipient.inbox.isAdmittedSource("peer")
                ? { delivered: true as const }
                : {
                    delivered: false as const,
                    reason: "admission" as const,
                }
            : await reg.wakeForPeerMessage(caller, recipient, stored.seq);
        return {
            kind: "output",
            output: JSON.stringify({
                message_id: stored.seq,
                stored: true,
                recipient_live: recipientLive,
                notice,
                delivered: delivery.delivered,
                ...(delivery.delivered
                    ? {}
                    : { not_delivered_because: delivery.reason }),
                ...(effect.replyTo === undefined
                    ? {}
                    : { reply_to_applied: replyTo !== undefined }),
            }),
            isError: false,
        };
    }

export async function wakeForPeerMessage(_reg: AgentRegistry, caller: RegisteredAgentEntry, recipient: RegisteredAgentEntry, seq: number): Promise<{
        readonly delivered: boolean;
        readonly reason?:
            | "approval_mode"
            | "hop_limit"
            | "rate_limit"
            | "unavailable"
            | "admission";
    }> {
        if (
            recipient.approvalMode !== "auto"
            && recipient.approvalMode !== "full_access"
        ) {
            return { delivered: false, reason: "approval_mode" };
        }
        const hop = caller.peerHop + 1;
        if (hop > MAX_PEER_HOP) {
            return { delivered: false, reason: "hop_limit" };
        }
        const now = Date.now();
        const wakes = recipient.peerWakes.filter(
            (at) => now - at < PEER_WAKE_WINDOW_MS,
        );
        if (wakes.length >= MAX_PEER_WAKES_PER_WINDOW) {
            recipient.peerWakes = wakes;
            return { delivered: false, reason: "rate_limit" };
        }
        try {
            await recordDeliveryAndNotify(recipient.store, recipient.events, {
                id: `peer:${caller.store.header.id}:${seq}`,
                sourceAgentId: caller.store.header.id,
                content: `Peer ${caller.store.header.id} sent message ${seq}. `
                    + "Read it with agent_inbox.",
                kind: "peer",
            });
            recipient.agent.triggerDeliveryTurn();
        } catch {
            return { delivered: false, reason: "unavailable" };
        }
        recipient.peerWakes = [...wakes, now];
        recipient.peerHop = hop;
        return { delivered: true };
    }

export async function applyAgentInboxEffect(reg: AgentRegistry, callerId: string, effect: AgentInboxEffect): Promise<AppliedToolEffectOutput> {
        const caller = reg.agents.get(callerId);
        const coordinator = reg.options.inboxDelivery;
        if (caller === undefined || caller.inbox === undefined || coordinator === undefined) {
            return toolError("Native inbox participation is unavailable in this session.");
        }
        const entry = caller.inbox.consumer.read({
            limit: 1,
            addresses: [callerId],
        })[0];
        if (entry === undefined) {
            return {
                kind: "output",
                output: JSON.stringify({ unread: false }),
                isError: false,
            };
        }
        if (effect.messageId !== undefined && effect.messageId !== entry.seq) {
            return toolError(
                `Message ${effect.messageId} is not next; read message ${entry.seq} first.`,
            );
        }
        const message = parsePeerMessage(entry);
        if (message === undefined) {
            const read = parsePeerRead(entry);
            const output = read === undefined
                ? genericInboxResult(entry)
                : {
                    message_id: entry.seq,
                    kind: PEER_READ_KIND,
                    from: entry.actor,
                    to: entry.address,
                    read_message_id: read.message_id,
                    complete: true,
                };
            return {
                kind: "output",
                output: JSON.stringify(output),
                isError: false,
                afterCommit: acknowledgeAfterCommit(entry.seq),
            };
        }

        const envelope = {
            message_id: entry.seq,
            kind: PEER_MESSAGE_KIND,
            from: message.from,
            to: message.to,
            text: message.text,
            ...(message.reply_to === undefined
                ? {}
                : { reply_to: message.reply_to }),
        };
        return {
            kind: "output",
            output: JSON.stringify({ ...envelope, complete: true }),
            isError: false,
            afterCommit: acknowledgeAfterCommit(
                entry.seq,
                message.from,
            ),
        };
    }

export async function renameSession(reg: AgentRegistry, targetId: string, name: string | null): Promise<RenameSessionOutcome> {
        const requested = normalizeSessionName(name);
        if (requested === undefined) {
            return { status: "invalid" };
        }
        const entry = reg.agents.get(targetId);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return { status: "not_found" };
        }
        if (entry.agent.attached) {
            return { status: "busy" };
        }
        try {
            const result = await reg.updateSessionName(targetId, requested);
            return result === undefined
                ? { status: "not_found" }
                : { status: "renamed", name: result };
        } catch {
            return { status: "failed" };
        }
    }

export async function updateSessionName(reg: AgentRegistry, id: string, name: string | null): Promise<string | null | undefined> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return undefined;
        }
        await entry.store.appendName(name);
        return entry.store.name() ?? null;
    }

export function onRosterChanged(reg: AgentRegistry, listener: () => void): () => void {
        reg.rosterListeners.add(listener);
        return (): void => {
            reg.rosterListeners.delete(listener);
        };
    }

export function notifyRosterChanged(reg: AgentRegistry): void {
        for (const listener of [...reg.rosterListeners]) {
            try {
                listener();
            } catch {
                // One client's failure must not stop the others being told.
            }
        }
    }

export function list(reg: AgentRegistry): RegisteredAgentSummary[] {
        const sizeOnDisk = (path: string): number | undefined => {
            try {
                return statSync(path).size;
            } catch {
                return undefined;
            }
        };

        return [...reg.agents.values()]
            .filter((entry) => !entry.ephemeral && !entry.pendingPublication)
            .map((entry) => {
                const activeEntries = entry.store.activeEntries();
                const firstUserEntry = activeEntries.find(
                    (candidate) => candidate.message.role === "user"
                        && candidate.message.internal !== true,
                );
                const firstUserMessage = firstUserEntry?.message;
                const fallbackTitle = firstUserMessage?.role === "user"
                    ? firstUserMessage.content
                        .flatMap((content) => content.type === "text"
                            ? [content.text]
                            : [])
                        .join(" ")
                        .replaceAll(/\s+/g, " ")
                        .trim()
                    : undefined;
                const title = entry.store.name() ?? fallbackTitle;
                const size = sizeOnDisk(entry.store.path);
                return {
                    id: entry.agent.id,
                    name: entry.identity?.name,
                    workspace: entry.agent.workspace,
                    session_path: entry.store.path,
                    kind: entry.kind,
                    status: entry.failure !== undefined
                        ? "failed" as const
                        : entry.agent.closed
                            ? "closed" as const
                            : entry.completed && entry.agent.status === "idle"
                                ? "completed" as const
                                : entry.agent.status,
                    live: entryIsLive(entry),
                    ...(entry.worker === undefined
                        ? {}
                        : {
                            worker_pid: entry.worker.pid,
                            ...(entry.worker.supervisor?.pid === null
                                    || entry.worker.supervisor?.pid === undefined
                                ? {}
                                : { supervisor_pid: entry.worker.supervisor.pid }),
                        }),
                    ...(title === undefined || title.length === 0
                        ? {}
                        : { title: title.slice(0, 80) }),
                    has_user_content: firstUserEntry !== undefined,
                    ...(entry.store.header.origin === undefined
                        ? {}
                        : { forked_from: entry.store.header.origin.sessionId }),
                    ...importedSessionSummary(entry.store.header),
                    ...(entry.parentId === undefined
                        ? {}
                        : { parent_id: entry.parentId }),
                    updated_at: entry.store.agentFailure()?.timestamp
                        ?? activeEntries.at(-1)?.timestamp
                        ?? entry.store.header.timestamp,
                    ...(size === undefined ? {} : { size_bytes: size }),
                };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
    }

export function workFacts(reg: AgentRegistry): readonly WorkAgentFacts[] {
        const unreadResults = new Set<string>();
        for (const entry of reg.agents.values()) {
            for (const delivery of entry.store.pendingDeliveries()) {
                if (delivery.kind !== "attention") {
                    unreadResults.add(delivery.sourceAgentId);
                }
            }
        }
        return reg.list().flatMap((summary) => {
            const entry = reg.agents.get(summary.id);
            if (entry === undefined) return [];
            const failure = entry.store.agentFailure()?.detail;
            const activeTool = entry.agent.activeTool;
            const changed = summary.status === "working"
                    || summary.status === "waiting"
                ? 0
                : sessionChangedFiles(summary.id).length;
            return [{
                id: summary.id,
                session_path: summary.session_path,
                title: summary.title ?? summary.name ?? summary.id,
                workspace: summary.workspace,
                kind: summary.kind,
                status: summary.status,
                live: summary.live,
                updated_at: summary.updated_at
                    ?? entry.store.header.timestamp,
                ...(summary.parent_id === undefined
                    ? {}
                    : { parent_id: summary.parent_id }),
                ...(entry.agent.pendingRequests[0] === undefined
                    ? {}
                    : { pending_request: entry.agent.pendingRequests[0] }),
                ...(activeTool === undefined ? {} : { active_tool: activeTool }),
                ...(unreadResults.has(summary.id) ? { unread_result: true } : {}),
                ...(changed === 0 ? {} : { changed_files: changed }),
                ...(failure === undefined ? {} : { failure }),
            }];
        });
    }

export function scheduleWorkFacts(_reg: AgentRegistry, runs: readonly EmittedScheduleRun[], agents: readonly WorkAgentFacts[]): readonly WorkScheduleFacts[] {
        const listed = new Map(agents.map((agent) => [agent.id, agent]));
        return runs.flatMap((run) => {
            const agent = listed.get(run.address);
            return agent === undefined ? [] : [{
                schedule_id: run.scheduleId,
                session_id: agent.id,
                session_path: agent.session_path,
                title: agent.title,
                workspace: agent.workspace,
                completed_at: run.emittedAt,
            }];
        });
    }

export async function requestInboxAdmission(_reg: AgentRegistry, entry: RegisteredAgentEntry, candidate: InboxAdmissionCandidate, signal: AbortSignal): Promise<InboxAdmissionDecision | undefined> {
        const inbound = entry.inbound;
        if (inbound === undefined || !entry.agent.attached) return undefined;

        const result = await inbound.requestUserQuestion({
            question:
                `Inbox source ${candidate.sourceFamily}: ${candidate.kind} `
                + `from ${candidate.source} (${candidate.ts})\n`
                + "Admit this source?",
            choices: [
                {
                    id: "once",
                    label: "Once",
                    description: "Admit this entry and hold future entries.",
                },
                {
                    id: "session",
                    label: "This session",
                    description: "Admit this source family until disconnect.",
                },
                {
                    id: "always",
                    label: "Always",
                    description: "Remember this source family after choosing a scope.",
                },
            ],
        }, { signal, outOfBand: true });
        if (result.outcome !== "selected") return undefined;
        if (result.choice.id === "once") return { mode: "once" };
        if (result.choice.id === "session") return { mode: "session" };
        if (result.choice.id !== "always") return undefined;

        const scopeResult = await inbound.requestUserQuestion({
            question: `Where should ${candidate.sourceFamily} be admitted?`,
            choices: [
                {
                    id: "user",
                    label: "User",
                    description: "Apply this admission across your Vera sessions.",
                },
                {
                    id: "project",
                    label: "Project",
                    description: "Apply this admission in this workspace.",
                },
            ],
        }, { signal, outOfBand: true });
        if (scopeResult.outcome !== "selected") return undefined;
        if (scopeResult.choice.id === "user") {
            return { mode: "always", scope: "user" };
        }
        if (
            scopeResult.choice.id === "project"
        ) {
            return { mode: "always", scope: "project" };
        }
        return undefined;
    }
