import { createConnection, type Socket } from "node:net";

import {
    parseClientCommand,
    type ClientCommand,
} from "../engine/protocol.ts";
import type { SessionFactName } from "../store/session-facts.ts";
import type { RegisteredAgentSummary } from "./agent-registry.ts";
import type { BackgroundAgentsSnapshot } from "./background-agents.ts";
import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "../extensions/commands.ts";
import { isApprovalMode } from "../sdk/permissions.ts";
import type { ScheduleOperation } from "../scheduler/types.ts";
import { parseHostCapabilities } from "./capabilities.ts";
import type { WorkIndexSnapshot } from "./work-index.ts";
import type {
    SessionSearchQuery,
    SessionSearchResults,
} from "../store/session-search.ts";
import { isStartupProfile, type StartupProfile } from "../startup-profile.ts";

// Bump this only when the base wire contract changes. Additive operations use
// negotiated capabilities and keep the compatibility floor unchanged.
export const HOST_PROTOCOL_VERSION = 32;
export const HOST_MIN_COMPATIBLE_PROTOCOL_VERSION = 30;

export interface HostIdentity {
    readonly pid: number;
    readonly started_at: string;
    readonly protocol_version?: number;
    readonly minimum_compatible_protocol_version?: number;
}

export interface HostIdentityRequest {
    readonly type: "host_identity";
}

export interface ListAgentsRequest {
    readonly type: "list_agents";
    readonly include?: readonly SessionFactName[];
    /** Row order. Defaults to id, which is the historic shape. */
    readonly order?: "id" | "recent";
    /** Rows per page. Absent means every row, which is the historic shape. */
    readonly limit?: number;
    /** Opaque position from a previous response's `next_cursor`. */
    readonly cursor?: string;
}

export interface SearchSessionsRequest {
    readonly type: "search_sessions";
    readonly query: SessionSearchQuery;
}

export interface SearchSessionsResponse {
    readonly type: "session_search_results";
    readonly results: SessionSearchResults;
}

/** The host is running without a session directory to scan. */
export interface SearchSessionsUnavailableResponse {
    readonly type: "session_search_unavailable";
}

export interface ScheduleOperationRequest {
    readonly type: "schedule_operation";
    readonly operation: ScheduleOperation;
}

export interface ScheduleOperationResponse {
    readonly type: "schedule_result";
    readonly result: Record<string, unknown>;
}

export interface ScheduleOperationFailedResponse {
    readonly type: "schedule_failed";
    readonly reason: string;
}

export interface ShutdownIfIdleRequest {
    readonly type: "shutdown_if_idle";
    readonly pid: number;
    readonly started_at: string;
    readonly requester_protocol_version: number;
}

export interface ShutdownForReplacementRequest {
    readonly type: "shutdown_for_replacement";
    readonly pid: number;
    readonly started_at: string;
    readonly requester_protocol_version: number;
}

export interface CreateAgentRequest {
    readonly type: "create_agent";
    readonly workspace: string;
    readonly approval_mode?: string;
    readonly lifetime?: "ephemeral" | "durable";
    readonly startup_profile?: StartupProfile;
}

export interface ResumeAgentRequest {
    readonly type: "resume_agent";
    readonly session_path: string;
}

export interface BranchAgentRequest {
    readonly type: "branch_agent";
    readonly source_agent_id: string;
    readonly position: "before" | "at";
    readonly entry_id?: string;
    readonly approval_mode?: string;
    readonly lifetime?: "ephemeral" | "durable";
    readonly initial_messages?: readonly {
        readonly role: "user";
        readonly content: readonly { readonly type: "text"; readonly text: string }[];
        readonly internal?: boolean;
        readonly compactionBarrier?: boolean;
    }[];
    readonly hide_inherited_messages?: boolean;
}

export interface CommitAgentBranchRequest {
    readonly type: "commit_agent_branch";
    readonly agent_id: string;
}

export interface SyncAgentContextRequest {
    readonly type: "sync_agent_context";
    readonly agent_id: string;
}

export interface AgentContextSyncedResponse {
    readonly type: "agent_context_synced";
    readonly outcome:
        | "synced"
        | "unchanged"
        | "busy"
        | "stale_cursor"
        | "not_found"
        | "failed";
    readonly turns: number;
}

/**
 * One prompt, one turn, one agent that the host closes when the turn ends.
 *
 * `approval_mode` names a mode the config already defines. Print mode adds no
 * permission vocabulary of its own: it decides nothing about what is allowed,
 * only that nobody is there to be asked.
 */
export interface RunOnceRequest {
    readonly type: "run_once";
    readonly workspace: string;
    readonly prompt: string;
    readonly approval_mode?: string;
    /** A pool entry, by its user-chosen name or its `provider/model` id. */
    readonly model?: string;
    readonly effort?: string;
    readonly startup_profile?: StartupProfile;
}

export interface RunOnceFinishedResponse {
    readonly type: "run_once_finished";
    readonly agent_id: string;
    readonly session_path: string;
    readonly text: string;
    readonly outcome: "completed" | "error" | "aborted";
    readonly error?: string;
    /** Decisions the run made because nobody was there to make them. */
    readonly notes?: readonly string[];
}

/** The run never started, so there is no agent and no turn to report on. */
export interface RunOnceFailedResponse {
    readonly type: "run_once_failed";
    readonly reason?: string;
}

export interface TrashSessionRequest {
    readonly type: "trash_session";
    readonly target_agent_id: string;
}

export interface RenameSessionRequest {
    readonly type: "rename_session";
    readonly target_agent_id: string;
    readonly name: string | null;
}

export interface HostIdentityResponse {
    readonly type: "host_identity";
    readonly pid: number;
    readonly started_at: string;
    readonly protocol_version: typeof HOST_PROTOCOL_VERSION;
    readonly minimum_compatible_protocol_version:
        typeof HOST_MIN_COMPATIBLE_PROTOCOL_VERSION;
}

export interface AttachRequest {
    readonly type: "attach";
    readonly agent_id: string;
    readonly requested_capabilities?: readonly string[];
    readonly after_seq?: number;
}

export interface DetachRequest {
    readonly type: "detach";
}

export interface ListExtensionCommandsRequest {
    readonly type: "list_extension_commands";
    readonly request_id: string;
}

export interface RunExtensionCommandRequest {
    readonly type: "run_extension_command";
    readonly request_id: string;
    readonly command: string;
    readonly arguments_text: string;
}

export interface ExtensionCommandListResponse {
    readonly type: "extension_command_list";
    readonly request_id: string;
    readonly commands: readonly ExtensionCommandDescriptor[];
}

export interface ExtensionCommandResultResponse {
    readonly type: "extension_command_result";
    readonly request_id: string;
    readonly result: ExtensionCommandResult;
}

export interface ExtensionCommandFailedResponse {
    readonly type: "extension_command_failed";
    readonly request_id: string;
    readonly failure: {
        readonly source: string;
        readonly reason:
            | "unavailable"
            | "handler_failed"
            | "timeout"
            | "cancelled"
            | "invalid_result";
        readonly message?: string;
    };
}

export type ExtensionCommandHostResponse =
    | ExtensionCommandListResponse
    | ExtensionCommandResultResponse
    | ExtensionCommandFailedResponse;

export interface AttachedResponse {
    readonly type: "attached";
    readonly agent_id: string;
    readonly workspace: string;
    /** Present when this attachment can only replay a terminal failure. */
    readonly failed?: true;
    /**
     * The background-agent facts as of the attach, so a client has a correct
     * count to draw before anything changes rather than after the first change.
     */
    readonly background_agents: BackgroundAgentsSnapshot;
    readonly capabilities: readonly string[];
}

/**
 * Sent whenever the attached client's view of background work changes.
 *
 * Unsolicited and unsequenced: it is a host fact about other sessions, not an
 * engine update about this one, so it stays out of the agent update sequence.
 */
export interface BackgroundAgentsResponse {
    readonly type: "background_agents";
    readonly running: number;
    readonly children: readonly string[];
    readonly has_parent: boolean;
}

/**
 * Sent whenever the work this host is holding changes, to clients that asked
 * for it. Unsolicited and unsequenced for the same reason as
 * `background_agents`: it is a fact about every session, not an engine update
 * about the attached one, so it stays out of the agent update sequence.
 */
export interface WorkIndexResponse {
    readonly type: "work_index";
    readonly index: WorkIndexSnapshot;
}

export interface AttachFailedResponse {
    readonly type: "attach_failed";
    readonly agent_id: string;
    readonly reason: "not_found" | "unavailable";
    readonly unavailable_reason?: "provider_unavailable";
    readonly provider?: string;
}

export interface DetachedResponse {
    readonly type: "detached";
}

export interface AgentListResponse {
    readonly type: "agent_list";
    readonly agents: readonly RegisteredAgentSummary[];
    /** Absent once the listing is exhausted. */
    readonly next_cursor?: string;
    /** Rows in the whole listing, not in this page. */
    readonly total?: number;
}

export interface AgentReadyResponse {
    readonly type: "agent_ready";
    readonly agent_id: string;
    readonly workspace: string;
}

export interface AgentStartFailedResponse {
    readonly type: "agent_start_failed";
    readonly operation: "create" | "resume";
    /**
     * Present only when the failure was phrased for the person running Vera.
     * Internal error text stays inside the host, which is why this is a separate
     * field rather than the message of whatever was thrown.
     */
    readonly reason?: string;
    readonly reason_code?: "provider_unavailable";
    readonly provider?: string;
}

export interface AgentBranchedResponse {
    readonly type: "agent_branched";
    readonly agent_id: string;
    readonly workspace: string;
    readonly requires_commit?: true;
    readonly prompt?: {
        readonly role: "user";
        readonly content: readonly (
            | { readonly type: "text"; readonly text: string }
            | {
                readonly type: "image_attachment";
                readonly attachmentId: string;
            }
        )[];
    };
}

export interface AgentBranchCommittedResponse {
    readonly type: "agent_branch_committed";
    readonly agent_id: string;
}

export interface AgentBranchFailedResponse {
    readonly type: "agent_branch_failed";
    readonly reason?: "unsupported_options" | "source_unavailable" | "failed";
}

export interface SessionTrashedResponse {
    readonly type: "session_trashed";
    readonly agent_id: string;
}

export interface SessionTrashRejectedResponse {
    readonly type: "session_trash_rejected";
    readonly agent_id: string;
    readonly reason: "busy" | "not_found" | "failed";
}

export interface SessionRenamedResponse {
    readonly type: "session_renamed";
    readonly agent_id: string;
    readonly name: string | null;
}

export interface SessionRenameRejectedResponse {
    readonly type: "session_rename_rejected";
    readonly agent_id: string;
    readonly reason: "invalid" | "busy" | "not_found" | "failed";
}

export interface ShutdownIfIdleAcceptedResponse {
    readonly type: "shutdown_if_idle_accepted";
    readonly pid: number;
    readonly started_at: string;
}

export interface ShutdownIfIdleRefusedResponse {
    readonly type: "shutdown_if_idle_refused";
    readonly reason: "busy" | "identity_mismatch" | "requester_not_newer";
}

export type ShutdownIfIdleResponse =
    | ShutdownIfIdleAcceptedResponse
    | ShutdownIfIdleRefusedResponse;

export interface ShutdownForReplacementAcceptedResponse {
    readonly type: "shutdown_for_replacement_accepted";
    readonly pid: number;
    readonly started_at: string;
}

export interface ShutdownForReplacementRefusedResponse {
    readonly type: "shutdown_for_replacement_refused";
    readonly reason: "busy" | "identity_mismatch" | "requester_not_newer";
}

export type ShutdownForReplacementResponse =
    | ShutdownForReplacementAcceptedResponse
    | ShutdownForReplacementRefusedResponse;

export interface ProtocolErrorResponse {
    readonly type: "protocol_error";
    readonly reason: "unsupported_or_invalid_command" | "frame_too_large";
}

export type HostRequest =
    | HostIdentityRequest
    | ListAgentsRequest
    | SearchSessionsRequest
    | ScheduleOperationRequest
    | ShutdownIfIdleRequest
    | ShutdownForReplacementRequest
    | CreateAgentRequest
    | ResumeAgentRequest
    | BranchAgentRequest
    | CommitAgentBranchRequest
    | SyncAgentContextRequest
    | TrashSessionRequest
    | RenameSessionRequest
    | RunOnceRequest
    | AttachRequest;
export type AttachedClientMessage =
    | ClientCommand
    | DetachRequest
    | ListExtensionCommandsRequest
    | RunExtensionCommandRequest;
export type HostResponse =
    | HostIdentityResponse
    | AgentListResponse
    | SearchSessionsResponse
    | SearchSessionsUnavailableResponse
    | ScheduleOperationResponse
    | ScheduleOperationFailedResponse
    | AgentReadyResponse
    | AgentStartFailedResponse
    | AgentBranchedResponse
    | AgentBranchCommittedResponse
    | AgentBranchFailedResponse
    | AgentContextSyncedResponse
    | SessionTrashedResponse
    | SessionTrashRejectedResponse
    | SessionRenamedResponse
    | SessionRenameRejectedResponse
    | RunOnceFinishedResponse
    | RunOnceFailedResponse
    | ShutdownIfIdleResponse
    | ShutdownForReplacementResponse
    | AttachedResponse
    | BackgroundAgentsResponse
    | WorkIndexResponse
    | AttachFailedResponse
    | DetachedResponse
    | ExtensionCommandHostResponse
    | ProtocolErrorResponse;

const SESSION_FACT_NAMES: readonly SessionFactName[] = [
    "usage",
    "context",
    "failure",
    "model",
];

/** Unknown names are dropped rather than refused, so a newer client still lists. */
function parseSessionFactNames(
    value: unknown,
): readonly SessionFactName[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const names = value.filter((entry): entry is SessionFactName =>
        typeof entry === "string"
        && SESSION_FACT_NAMES.includes(entry as SessionFactName)
    );
    return names.length === 0 ? undefined : [...new Set(names)];
}

export function parseHostRequest(source: string): HostRequest | undefined {
    const value = parseJsonObject(source);
    if (value?.type === "host_identity") {
        return { type: "host_identity" };
    }
    if (value?.type === "list_agents") {
        const include = parseSessionFactNames(value.include);
        const order = value.order === "recent" ? "recent" : undefined;
        const limit = value.limit;
        const cursor = value.cursor;
        return {
            type: "list_agents",
            ...(include === undefined ? {} : { include }),
            ...(order === undefined ? {} : { order }),
            ...(typeof limit === "number" && Number.isSafeInteger(limit)
                    && limit > 0
                ? { limit }
                : {}),
            ...(typeof cursor === "string" && cursor.length > 0
                ? { cursor }
                : {}),
        };
    }
    if (value?.type === "search_sessions") {
        const query = parseSessionSearchQuery(value.query);
        if (query !== undefined) {
            return { type: "search_sessions", query };
        }
    }
    if (value?.type === "schedule_operation") {
        const operation = parseScheduleOperation(value.operation);
        if (operation !== undefined) {
            return { type: "schedule_operation", operation };
        }
    }
    if (
        (value?.type === "shutdown_if_idle"
            || value?.type === "shutdown_for_replacement")
        && Number.isInteger(value.pid)
        && (value.pid as number) > 0
        && typeof value.started_at === "string"
        && !Number.isNaN(Date.parse(value.started_at))
        && Number.isSafeInteger(value.requester_protocol_version)
        && (value.requester_protocol_version as number) > 0
    ) {
        return {
            type: value.type,
            pid: value.pid as number,
            started_at: value.started_at,
            requester_protocol_version:
                value.requester_protocol_version as number,
        };
    }
    if (
        value?.type === "create_agent"
        && typeof value.workspace === "string"
        && value.workspace.length > 0
        && (value.approval_mode === undefined
            || isApprovalMode(value.approval_mode))
        && (value.lifetime === undefined
            || value.lifetime === "ephemeral"
            || value.lifetime === "durable")
        && (value.startup_profile === undefined
            || isStartupProfile(value.startup_profile))
    ) {
        return {
            type: "create_agent",
            workspace: value.workspace,
            ...(value.approval_mode === undefined
                ? {}
                : { approval_mode: value.approval_mode }),
            ...(value.lifetime === undefined
                ? {}
                : { lifetime: value.lifetime }),
            ...(value.startup_profile === undefined
                ? {}
                : { startup_profile: value.startup_profile }),
        };
    }
    if (
        value?.type === "resume_agent"
        && typeof value.session_path === "string"
        && value.session_path.length > 0
    ) {
        return { type: "resume_agent", session_path: value.session_path };
    }
    if (
        value?.type === "branch_agent"
        && typeof value.source_agent_id === "string"
        && value.source_agent_id.length > 0
        && value.source_agent_id.length <= 256
        && (value.position === "before" || value.position === "at")
        && (
            value.position === "at"
                ? value.entry_id === undefined
                : typeof value.entry_id === "string"
                    && value.entry_id.length > 0
        )
        && (value.approval_mode === undefined
            || isApprovalMode(value.approval_mode))
        && (value.lifetime === undefined
            || value.lifetime === "ephemeral"
            || value.lifetime === "durable")
        && isBranchInitialMessages(value.initial_messages)
        && (value.hide_inherited_messages === undefined
            || typeof value.hide_inherited_messages === "boolean")
    ) {
        if (value.position === "at") {
            return {
                type: "branch_agent",
                source_agent_id: value.source_agent_id,
                position: "at",
                ...(value.approval_mode === undefined
                    ? {}
                    : { approval_mode: value.approval_mode }),
                ...(value.lifetime === undefined
                    ? {}
                    : { lifetime: value.lifetime }),
                ...(value.initial_messages === undefined
                    ? {}
                    : { initial_messages: value.initial_messages }),
                ...(value.hide_inherited_messages === true
                    ? { hide_inherited_messages: true }
                    : {}),
            };
        }
        return {
            type: "branch_agent",
            source_agent_id: value.source_agent_id,
            position: "before",
            entry_id: value.entry_id as string,
            ...(value.approval_mode === undefined
                ? {}
                : { approval_mode: value.approval_mode }),
            ...(value.lifetime === undefined
                ? {}
                : { lifetime: value.lifetime }),
            ...(value.initial_messages === undefined
                ? {}
                : { initial_messages: value.initial_messages }),
            ...(value.hide_inherited_messages === true
                ? { hide_inherited_messages: true }
                : {}),
        };
    }
    if (
        value?.type === "commit_agent_branch"
        && typeof value.agent_id === "string"
        && value.agent_id.length > 0
    ) {
        return { type: "commit_agent_branch", agent_id: value.agent_id };
    }
    if (
        value?.type === "sync_agent_context"
        && typeof value.agent_id === "string"
        && value.agent_id.length > 0
    ) {
        return { type: "sync_agent_context", agent_id: value.agent_id };
    }
    if (
        value?.type === "trash_session"
        && typeof value.target_agent_id === "string"
        && value.target_agent_id.length > 0
    ) {
        return {
            type: "trash_session",
            target_agent_id: value.target_agent_id,
        };
    }
    if (
        value?.type === "rename_session"
        && typeof value.target_agent_id === "string"
        && value.target_agent_id.length > 0
        && (value.name === null
            || (typeof value.name === "string" && value.name.length > 0))
    ) {
        return {
            type: "rename_session",
            target_agent_id: value.target_agent_id,
            name: value.name as string | null,
        };
    }
    if (
        value?.type === "run_once"
        && typeof value.workspace === "string"
        && value.workspace.length > 0
        && typeof value.prompt === "string"
        && value.prompt.trim().length > 0
        && (value.startup_profile === undefined
            || isStartupProfile(value.startup_profile))
        && (value.approval_mode === undefined
            || (typeof value.approval_mode === "string"
                && value.approval_mode.length > 0))
        && (value.model === undefined
            || (typeof value.model === "string" && value.model.length > 0))
        && (value.effort === undefined
            || (typeof value.effort === "string" && value.effort.length > 0))
    ) {
        return {
            type: "run_once",
            workspace: value.workspace,
            prompt: value.prompt,
            ...(value.approval_mode === undefined
                ? {}
                : { approval_mode: value.approval_mode as string }),
            ...(value.model === undefined
                ? {}
                : { model: value.model as string }),
            ...(value.effort === undefined
                ? {}
                : { effort: value.effort as string }),
            ...(value.startup_profile === undefined
                ? {}
                : { startup_profile: value.startup_profile }),
        };
    }
    if (
        value?.type === "attach"
        && typeof value.agent_id === "string"
        && value.agent_id.length > 0
        && (value.requested_capabilities === undefined
            || parseHostCapabilities(value.requested_capabilities) !== undefined)
        && (value.after_seq === undefined
            || (Number.isSafeInteger(value.after_seq)
                && (value.after_seq as number) >= 0))
    ) {
        const requestedCapabilities = value.requested_capabilities === undefined
            ? undefined
            : parseHostCapabilities(value.requested_capabilities);
        return {
            type: "attach",
            agent_id: value.agent_id,
            ...(requestedCapabilities === undefined
                ? {}
                : { requested_capabilities: requestedCapabilities }),
            ...(value.after_seq === undefined
                ? {}
                : { after_seq: value.after_seq as number }),
        };
    }
    return undefined;
}

function isBranchInitialMessages(
    value: unknown,
): value is BranchAgentRequest["initial_messages"] {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.length > 8) return false;
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 48 * 1_024) {
        return false;
    }
    return value.every((message) => {
            if (typeof message !== "object" || message === null) return false;
            const candidate = message as Record<string, unknown>;
            return candidate.role === "user"
                && (candidate.internal === undefined
                    || typeof candidate.internal === "boolean")
                && (candidate.compactionBarrier === undefined
                    || typeof candidate.compactionBarrier === "boolean")
                && Array.isArray(candidate.content)
                && candidate.content.length === 1
                && candidate.content.every((content) => {
                    if (typeof content !== "object" || content === null) {
                        return false;
                    }
                    const text = (content as Record<string, unknown>).text;
                    if (
                        (content as Record<string, unknown>).type !== "text"
                        || typeof text !== "string"
                        || text.length === 0
                        || text.length > 16_000
                    ) {
                        return false;
                    }
                    return true;
                });
        });
}

export function parseAttachedClientMessage(
    source: string,
): AttachedClientMessage | undefined {
    const value = parseJsonObject(source);
    if (value?.type === "detach") {
        return { type: "detach" };
    }
    if (
        value?.type === "list_extension_commands"
        && isRequestId(value.request_id)
    ) {
        return {
            type: "list_extension_commands",
            request_id: value.request_id,
        };
    }
    if (
        value?.type === "run_extension_command"
        && isRequestId(value.request_id)
        && typeof value.command === "string"
        && /^[a-z][a-z0-9-]*$/.test(value.command)
        && typeof value.arguments_text === "string"
    ) {
        return {
            type: "run_extension_command",
            request_id: value.request_id,
            command: value.command,
            arguments_text: value.arguments_text,
        };
    }
    return parseClientCommand(value);
}

export function encodeHostResponse(response: HostResponse): string {
    return `${JSON.stringify(response)}\n`;
}

export function requestHostIdentity(
    socketPath: string,
): Promise<HostIdentity | undefined> {
    return new Promise((resolve) => {
        let socket: Socket;
        try {
            socket = createConnection(socketPath);
        } catch {
            resolve(undefined);
            return;
        }
        let finished = false;
        let buffered = "";
        const deadline = setTimeout(() => finish(undefined), 250);
        const finish = (identity: HostIdentity | undefined): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(identity);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(`${JSON.stringify({ type: "host_identity" })}\n`);
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 4_096) {
                finish(undefined);
                return;
            }
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                finish(parseHostIdentity(buffered.slice(0, newline)));
            }
        });
        socket.once("error", () => finish(undefined));
        socket.once("end", () => finish(undefined));
        socket.once("close", () => finish(undefined));
    });
}

export function requestHostShutdownIfIdle(
    socketPath: string,
    identity: HostIdentity,
    requesterProtocolVersion: number = HOST_PROTOCOL_VERSION,
): Promise<ShutdownIfIdleResponse | undefined> {
    return new Promise((resolve) => {
        let socket: Socket;
        try {
            socket = createConnection(socketPath);
        } catch {
            resolve(undefined);
            return;
        }
        let finished = false;
        let buffered = "";
        const deadline = setTimeout(() => finish(undefined), 1_000);
        const finish = (response: ShutdownIfIdleResponse | undefined): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(response);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(`${JSON.stringify({
                type: "shutdown_if_idle",
                pid: identity.pid,
                started_at: identity.started_at,
                requester_protocol_version: requesterProtocolVersion,
            })}\n`);
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 4_096) {
                finish(undefined);
                return;
            }
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                finish(parseShutdownIfIdleResponse(buffered.slice(0, newline)));
            }
        });
        socket.once("error", () => finish(undefined));
        socket.once("end", () => finish(undefined));
        socket.once("close", () => finish(undefined));
    });
}

export function requestHostShutdownForReplacement(
    socketPath: string,
    identity: HostIdentity,
    requesterProtocolVersion: number = HOST_PROTOCOL_VERSION,
): Promise<ShutdownForReplacementResponse | undefined> {
    return requestHostShutdown(socketPath, {
        type: "shutdown_for_replacement",
        pid: identity.pid,
        started_at: identity.started_at,
        requester_protocol_version: requesterProtocolVersion,
    }, parseShutdownForReplacementResponse);
}

function requestHostShutdown<Response>(
    socketPath: string,
    request: ShutdownForReplacementRequest,
    parseResponse: (source: string) => Response | undefined,
): Promise<Response | undefined> {
    return new Promise((resolve) => {
        let socket: Socket;
        try {
            socket = createConnection(socketPath);
        } catch {
            resolve(undefined);
            return;
        }
        let finished = false;
        let buffered = "";
        const deadline = setTimeout(() => finish(undefined), 1_000);
        const finish = (response: Response | undefined): void => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(response);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(`${JSON.stringify(request)}\n`);
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 4_096) {
                finish(undefined);
                return;
            }
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                finish(parseResponse(buffered.slice(0, newline)));
            }
        });
        socket.once("error", () => finish(undefined));
        socket.once("end", () => finish(undefined));
        socket.once("close", () => finish(undefined));
    });
}

function parseHostIdentity(source: string): HostIdentity | undefined {
    const response = parseJsonObject(source);
    if (
        response?.type !== "host_identity"
        || !Number.isInteger(response.pid)
        || (response.pid as number) <= 0
        || typeof response.started_at !== "string"
        || Number.isNaN(Date.parse(response.started_at))
    ) {
        return undefined;
    }
    return {
        pid: response.pid as number,
        started_at: response.started_at,
        ...(Number.isSafeInteger(response.protocol_version)
            && (response.protocol_version as number) > 0
            ? { protocol_version: response.protocol_version as number }
            : {}),
        ...(Number.isSafeInteger(
                response.minimum_compatible_protocol_version,
            )
            && (response.minimum_compatible_protocol_version as number) > 0
            && Number.isSafeInteger(response.protocol_version)
            && (response.minimum_compatible_protocol_version as number)
                <= (response.protocol_version as number)
            ? {
                minimum_compatible_protocol_version:
                    response.minimum_compatible_protocol_version as number,
            }
            : {}),
    };
}

function parseShutdownIfIdleResponse(
    source: string,
): ShutdownIfIdleResponse | undefined {
    const response = parseJsonObject(source);
    if (
        response?.type === "shutdown_if_idle_accepted"
        && Number.isInteger(response.pid)
        && (response.pid as number) > 0
        && typeof response.started_at === "string"
        && !Number.isNaN(Date.parse(response.started_at))
    ) {
        return {
            type: "shutdown_if_idle_accepted",
            pid: response.pid as number,
            started_at: response.started_at,
        };
    }
    if (
        response?.type === "shutdown_if_idle_refused"
        && (
            response.reason === "busy"
            || response.reason === "identity_mismatch"
            || response.reason === "requester_not_newer"
        )
    ) {
        return {
            type: "shutdown_if_idle_refused",
            reason: response.reason,
        };
    }
    return undefined;
}

function parseShutdownForReplacementResponse(
    source: string,
): ShutdownForReplacementResponse | undefined {
    const response = parseJsonObject(source);
    if (
        response?.type === "shutdown_for_replacement_accepted"
        && Number.isInteger(response.pid)
        && (response.pid as number) > 0
        && typeof response.started_at === "string"
        && !Number.isNaN(Date.parse(response.started_at))
    ) {
        return {
            type: "shutdown_for_replacement_accepted",
            pid: response.pid as number,
            started_at: response.started_at,
        };
    }
    if (
        response?.type === "shutdown_for_replacement_refused"
        && (
            response.reason === "busy"
            || response.reason === "identity_mismatch"
            || response.reason === "requester_not_newer"
        )
    ) {
        return {
            type: "shutdown_for_replacement_refused",
            reason: response.reason,
        };
    }
    return undefined;
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return undefined;
    }
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/**
 * Bounded before anything reads a file: the query decides how much of every
 * transcript on disk gets scanned, so an unbounded one is a way to make the
 * host read the whole session directory on demand.
 */
function parseSessionSearchQuery(
    value: unknown,
): SessionSearchQuery | undefined {
    if (!isRecord(value)) return undefined;
    const query = value.query;
    if (typeof query !== "string" || query.length === 0 || query.length > 256) {
        return undefined;
    }
    const kind = value.kind;
    if (kind !== undefined
        && kind !== "messages"
        && kind !== "tools"
        && kind !== "files") {
        return undefined;
    }
    const workspace = value.workspace;
    if (workspace !== undefined
        && (typeof workspace !== "string"
            || workspace.length === 0
            || workspace.length > 4_096)) {
        return undefined;
    }
    return {
        query,
        ...(kind === undefined ? {} : { kind }),
        ...(workspace === undefined ? {} : { workspace }),
    };
}

function parseScheduleOperation(value: unknown): ScheduleOperation | undefined {
    if (!isRecord(value)) return undefined;
    const text = (key: string): string | undefined =>
        typeof value[key] === "string" && (value[key] as string).length > 0
            ? value[key] as string
            : undefined;
    switch (value.action) {
        case "add": {
            const id = text("id");
            const cron = text("cron");
            const timezone = text("timezone");
            const address = text("address");
            if (
                id === undefined
                || cron === undefined
                || timezone === undefined
                || address === undefined
                || !isRecord(value.payload)
            ) return undefined;
            return {
                action: "add",
                id,
                cron,
                timezone,
                address,
                payload: value.payload,
            };
        }
        case "list":
            return { action: "list" };
        case "show":
        case "pause":
        case "resume":
        case "remove":
        case "run": {
            const id = text("id");
            return id === undefined ? undefined : { action: value.action, id };
        }
        default:
            return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}
