import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import { SessionChangedFileCounts } from "../../store/preimage-stash.ts";
import { sessionSummary } from "./roster-summary.ts";
import type { AgentInboxEffect, AgentSendEffect, AppliedToolEffectOutput, ToolOutput } from "../../tools/types.ts";
import { workspaceKey } from "../../workspace-key.ts";
import { MAX_PEER_HOP, MAX_PEER_WAKES_PER_WINDOW, PEER_WAKE_WINDOW_MS, acknowledgeAfterCommit, entryIsLive, entryStatus, entryUpdatedAt, genericInboxResult, gitRosterFacts, normalizeSessionName, participantLabel, sameWorkspace, toolError, type RegisteredAgentEntry, type RegisteredAgentSummary, type RenameSessionOutcome } from "./support.ts";
import { recordDeliveryAndNotify } from "../delivery-notifier.ts";
import { UNCOUNTED_INBOX_KINDS, type InboxAdmissionCandidate, type InboxAdmissionDecision } from "../inbox-delivery.ts";
import { PEER_MESSAGE_KIND, RETIRED_PEER_READ_KIND, VERA_INBOX_SOURCE, parsePeerMessage, type PeerMessagePayload } from "../local-participation.ts";
import { EXTENSION_MESSAGE_KIND, extensionMessageFamily, parseExtensionMessage } from "../extension-messages.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "../work-index.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { VeraSessionSendOutcome, VeraSessionTitleOutcome } from "../../sdk/extensions.ts";

interface RosterNotification {
    summaries?: RegisteredAgentSummary[];
    facts?: readonly WorkAgentFacts[];
}

interface PendingSources {
    readonly revision: number;
    readonly sources: readonly string[];
}

const notifications = new WeakMap<AgentRegistry, RosterNotification>();
const pendingSources = new WeakMap<RegisteredAgentEntry["store"], PendingSources>();
const changedFileCounts = new WeakMap<RegisteredAgentEntry, SessionChangedFileCounts>();

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
                    excludeKinds: UNCOUNTED_INBOX_KINDS,
                }) ?? { count: 0, oldestAgeMs: null };
                const compact = {
                    participant_id: id,
                    name: entry.identity?.name,
                    ...(entry.store.name() === undefined
                        ? {}
                        : { title: entry.store.name() }),
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
        // A stray reply_to on a new note is dropped and reported as reply_to_applied: false.
        // If it comes up again, keep handling it here rather than adding guidance to the agent_send description.
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
        // Nobody can answer an admission prompt for a detached peer, so it wakes under the hop and rate caps.
        const delivery = recipient.agent.attached && inbox.hasAdmissionPath()
            ? recipient.inbox.isAdmittedSource("peer")
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

export async function wakeForPeerMessage(reg: AgentRegistry, caller: RegisteredAgentEntry, recipient: RegisteredAgentEntry, seq: number): Promise<{
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
            await recordPeerMessage(reg, recipient, participantLabel(caller), seq);
            recipient.agent.triggerDeliveryTurn();
        } catch {
            return { delivered: false, reason: "unavailable" };
        }
        recipient.peerWakes = [...wakes, now];
        recipient.peerHop = hop;
        return { delivered: true };
    }

// The message is delivered whole, so the recipient needs no agent_inbox call to read it.
async function recordPeerMessage(reg: AgentRegistry, recipient: RegisteredAgentEntry, fromLabel: string, seq: number): Promise<boolean> {
        const stored = reg.options.inboxDelivery?.entry(seq);
        const message = stored === undefined ? undefined : parsePeerMessage(stored);
        if (message === undefined) return true;
        const recorded = await recordDeliveryAndNotify(recipient.store, recipient.events, {
            id: `peer:${message.from}:${seq}`,
            sourceAgentId: message.from,
            content: message.text,
            kind: "peer",
            peer: {
                fromLabel,
                messageId: seq,
                ...(message.reply_to === undefined ? {} : { replyTo: message.reply_to }),
            },
        });
        recipient.inbox?.noteDelivered(seq);
        return recorded;
    }

function peerSenderLabel(reg: AgentRegistry, seq: number): string | undefined {
        const stored = reg.options.inboxDelivery?.entry(seq);
        const message = stored === undefined ? undefined : parsePeerMessage(stored);
        if (message === undefined) return undefined;
        const sender = reg.agents.get(message.from);
        return sender === undefined ? message.from : participantLabel(sender);
    }

// An admitted turn for a peer message needs the notice, or the recipient wakes with nothing new to read.
// A notice that cannot be recorded rejects, so the inbox starts the entry again at its next pump.
export async function startAdmittedInboxTurn(reg: AgentRegistry, recipient: RegisteredAgentEntry, candidate: InboxAdmissionCandidate): Promise<void> {
        if (candidate.kind === PEER_MESSAGE_KIND) {
            const sender = peerSenderLabel(reg, candidate.seq);
            // A notice already recorded by a detached wake is not repeated, and its turn is not run twice.
            if (sender !== undefined) {
                const recorded = await recordPeerMessage(reg, recipient, sender, candidate.seq);
                if (!recorded) return;
            }
        }
        if (candidate.kind === EXTENSION_MESSAGE_KIND) {
            const recorded = await recordExtensionNotice(reg, recipient, candidate.seq);
            if (!recorded) return;
        }
        try {
            recipient.agent.triggerDeliveryTurn();
        } catch {
            // A recipient closed since admission keeps the entry unread.
        }
    }

export async function sendExtensionMessage(reg: AgentRegistry, extensionId: string, id: string, text: string): Promise<VeraSessionSendOutcome> {
        const entry = reg.agents.get(id);
        const coordinator = reg.options.inboxDelivery;
        if (
            entry === undefined
            || entry.ephemeral
            || entry.agent.closed
            || entry.agent.failed
            || entry.inbox === undefined
            || coordinator === undefined
        ) {
            return "not_found";
        }
        if (extensionMessageFamily(extensionId) === undefined) {
            throw new Error(`Extension ${extensionId} cannot message sessions under a host source name`);
        }
        // Installing an extension with sessions.send is the user's consent, so its messages skip the prompt.
        await coordinator.appendAdmitted({
            source: extensionId,
            kind: EXTENSION_MESSAGE_KIND,
            address: id,
            payload: JSON.stringify({ version: 1, text }),
        });
        return "queued";
    }

// The extension's own text is the notice.
async function recordExtensionNotice(reg: AgentRegistry, recipient: RegisteredAgentEntry, seq: number): Promise<boolean> {
        const stored = reg.options.inboxDelivery?.entry(seq);
        const message = stored === undefined ? undefined : parseExtensionMessage(stored);
        if (stored === undefined || message === undefined) return true;
        const recorded = await recordDeliveryAndNotify(recipient.store, recipient.events, {
            id: `inbox:${seq}`,
            sourceAgentId: stored.source,
            content: message.text,
            kind: "attention",
            sourceKind: "extension",
        });
        recipient.inbox?.noteDelivered(seq);
        return recorded;
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
            excludeKinds: [RETIRED_PEER_READ_KIND],
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
            return {
                kind: "output",
                output: JSON.stringify(genericInboxResult(entry)),
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
            afterCommit: acknowledgeAfterCommit(entry.seq),
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
        reg.announceSessionUpdated(entry);
        return entry.store.name() ?? null;
    }

// A name the user set, or cleared, always beats a suggested one.
export async function setTitleIfUnnamed(reg: AgentRegistry, id: string, title: string): Promise<VeraSessionTitleOutcome> {
        const entry = reg.agents.get(id);
        if (entry === undefined || entry.ephemeral || entry.agent.closed || entry.agent.failed) {
            return "not_found";
        }
        const written = await entry.store.appendFirstName(title);
        if (written === undefined) {
            return "named";
        }
        reg.notifyRosterChanged();
        reg.announceSessionUpdated(entry);
        return "set";
    }

export function onRosterChanged(reg: AgentRegistry, listener: () => void): () => void {
        reg.rosterListeners.add(listener);
        return (): void => {
            reg.rosterListeners.delete(listener);
        };
    }

export function notifyRosterChanged(reg: AgentRegistry): void {
        const previous = notifications.get(reg);
        notifications.set(reg, {});
        try {
            for (const listener of [...reg.rosterListeners]) {
                try {
                    listener();
                } catch {
                    // One client's failure must not stop the others being told.
                }
            }
        } finally {
            if (previous === undefined) notifications.delete(reg);
            else {
                delete previous.summaries;
                delete previous.facts;
                notifications.set(reg, previous);
            }
        }
    }

export function list(reg: AgentRegistry): RegisteredAgentSummary[] {
        const notification = notifications.get(reg);
        if (notification?.summaries !== undefined) return notification.summaries;
        const summaries = [...reg.agents.values()]
            .filter((entry) => !entry.ephemeral && !entry.pendingPublication)
            .map(sessionSummary)
            .sort((left, right) => left.id.localeCompare(right.id));
        if (notification !== undefined) notification.summaries = summaries;
        return summaries;
    }

export function workFacts(reg: AgentRegistry): readonly WorkAgentFacts[] {
        const notification = notifications.get(reg);
        if (notification?.facts !== undefined) return notification.facts;
        const unreadResults = new Set<string>();
        for (const entry of reg.agents.values()) {
            for (const source of unreadSources(entry)) unreadResults.add(source);
        }
        const facts = reg.list().flatMap((summary) => {
            const entry = reg.agents.get(summary.id);
            if (entry === undefined) return [];
            const failure = entry.store.agentFailure()?.detail;
            const activeTool = entry.agent.activeTool;
            const changed = summary.status === "working"
                    || summary.status === "waiting"
                ? 0
                : changedFiles(entry);
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
        if (notification !== undefined) notification.facts = facts;
        return facts;
    }

function unreadSources(entry: RegisteredAgentEntry): readonly string[] {
    const revision = entry.store.appendedLineCount();
    const cached = pendingSources.get(entry.store);
    if (cached?.revision === revision) return cached.sources;
    const sources = entry.store.pendingDeliveries()
        .filter((delivery) => delivery.kind !== "attention")
        .map((delivery) => delivery.sourceAgentId);
    pendingSources.set(entry.store, { revision, sources });
    return sources;
}

function changedFiles(entry: RegisteredAgentEntry): number {
    let counts = changedFileCounts.get(entry);
    if (counts === undefined) {
        counts = new SessionChangedFileCounts();
        changedFileCounts.set(entry, counts);
    }
    return counts.read(entry.agent.id);
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

async function readyOrAborted(ready: Promise<void>, signal: AbortSignal): Promise<void> {
        if (signal.aborted) return;
        const aborted = Promise.withResolvers<void>();
        const onAbort = (): void => aborted.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            await Promise.race([ready, aborted.promise]);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    }

export async function requestInboxAdmission(reg: AgentRegistry, entry: RegisteredAgentEntry, candidate: InboxAdmissionCandidate, signal: AbortSignal): Promise<InboxAdmissionDecision | undefined> {
        // A question raised before the loop listens is lost, and a dismissal would drop it, so wait.
        await readyOrAborted(entry.loopReady, signal);
        // A worker's own router lives in the worker, so the host asks through the one it keeps for host-owned questions.
        const inbound = entry.workerOwnerRouter ?? entry.inbound;
        if (signal.aborted || inbound === undefined || !entry.agent.attached) return undefined;

        const sender = candidate.kind === PEER_MESSAGE_KIND
            ? peerSenderLabel(reg, candidate.seq)
            : undefined;
        const result = await inbound.requestUserQuestion(sender !== undefined ? {
            question:
                `${sender} wants to message this conversation.\n`
                + "Let messages from other conversations start a turn here?",
            choices: [
                {
                    id: "once",
                    label: "Just this one",
                    description: "Later messages wait until you read them.",
                },
                {
                    id: "session",
                    label: "This conversation",
                    description: "Until you leave it.",
                },
                {
                    id: "always",
                    label: "Always",
                    description: "Then pick User or Project.",
                },
            ],
        } : {
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
