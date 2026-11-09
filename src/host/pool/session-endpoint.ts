import type { CreateRegisteredAgentOptions, RegisteredAgentSummary, RenameSessionOutcome } from "../agent-registry.ts";
import type { PeerSessionServices } from "../agent-registry/peer-services.ts";
import type { SubagentSessionServices } from "../agent-registry/subagent-services.ts";
import type { BranchSyncDelta, BranchSyncInfo, BranchSyncOutcome, BranchSyncPrepared } from "../agent-registry/context-sync.ts";
import type { BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, CloseAgentOutcome, UnblockSessionOutcome } from "../server.ts";
import type { StoredSessionTreeRow } from "../session-block.ts";
import type { ExtensionSessionServices } from "../session-host/types.ts";
import type { SessionImportOutcome, ImportableSessionListing } from "../session-import-service.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import type { WorkAgentFacts, WorkScheduleFacts } from "../work-index.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import type { SessionFactName } from "../../store/session-facts.ts";
import type { SessionSearchQuery, SessionSearchResults, SessionSearchShard } from "../../store/session-search.ts";
import type { SessionOwner } from "./roster.ts";
import type { ClosedMember } from "../agent-registry/support.ts";
import type { TrashReservation, TrashRestartPlan } from "../agent-registry/trash.ts";

export interface RoutedSession {
    readonly id: string;
    readonly workspace: string;
    readonly sessionPath: string;
    readonly parentId?: string;
    readonly closed?: boolean;
    readonly failed?: boolean;
    readonly ephemeral?: boolean;
}

export interface InspectedSession {
    readonly id: string;
    readonly sessionPath: string;
    readonly parentId?: string;
}

export interface OwnedSession {
    readonly owner: SessionOwner;
    readonly session: RoutedSession;
}

export interface SessionSnapshot {
    readonly residents: readonly RoutedSession[];
    readonly summaries: readonly RegisteredAgentSummary[];
    readonly work: readonly WorkAgentFacts[];
    readonly unreadSources: readonly string[];
}

export interface SessionParkFacts {
    readonly id: string;
    readonly parentId?: string;
    readonly idle: boolean;
    readonly starting: boolean;
    readonly updatedAt: string;
}

export interface CloseTicket {
    readonly id: string;
    readonly token: string;
}

export interface SessionResumeOptions {
    readonly reserved?: boolean;
    readonly ownershipTransfer?: boolean;
}

export interface SessionEndpoint extends ExtensionSessionServices, PeerSessionServices, SubagentSessionServices {
    canonicalPath(path: string): Promise<string>;
    inspect(path: string): Promise<InspectedSession>;
    residentAt(path: string): Promise<RoutedSession | undefined>;
    resident(id: string): Promise<RoutedSession | undefined>;
    residents(): Promise<readonly RoutedSession[]>;
    tree(id: string): Promise<readonly string[]>;
    find(id: string, reserved?: boolean): Promise<RoutedSession | undefined>;
    create(options: Pick<CreateRegisteredAgentOptions,
        "id" | "workspace" | "approvalMode" | "ephemeral" | "startupProfile">): Promise<RoutedSession>;
    resume(path: string, options?: SessionResumeOptions): Promise<RoutedSession>;
    release(id: string): Promise<readonly string[] | undefined>;
    list(): Promise<readonly RegisteredAgentSummary[]>;
    rememberStored(summary: RegisteredAgentSummary): Promise<void>;
    forgetStored(id: string): Promise<void>;
    rename(id: string, name: string | null, reserved?: boolean): Promise<RenameSessionOutcome>;
    trash(id: string, reserved?: boolean): Promise<"trashed" | "busy" | "not_found" | "failed">;
    reserveTrash(ids: readonly string[], rootId: string, registeredIds: readonly string[], reservedIds: readonly string[]): Promise<TrashReservation>;
    quiesceClose(ids: readonly string[]): Promise<readonly CloseTicket[]>;
    waitClose(tickets: readonly CloseTicket[]): Promise<void>;
    finishCloseMember(ticket: CloseTicket, reason: SessionEndReason): Promise<ClosedMember | undefined>;
    forgetClose(tickets: readonly CloseTicket[]): Promise<void>;
    canClose(id: string): Promise<boolean>;
    recordClosedMembers(closed: readonly ClosedMember[]): Promise<void>;
    moveTrashArtifact(plan: TrashRestartPlan): Promise<boolean>;
    restartTrashMember(plan: TrashRestartPlan): Promise<boolean>;
    abandonTrashRestart(id: string): Promise<void>;
    recordTrashOutcome(rootId: string, closed: readonly ClosedMember[], trashed: boolean): Promise<void>;
    releaseTrash(ids: readonly string[]): Promise<void>;
    close(id: string, reason?: SessionEndReason): Promise<CloseAgentOutcome>;
    block(request: BlockSessionRequest): Promise<BlockSessionOutcome>;
    unblock(request: UnblockSessionRequest): Promise<UnblockSessionOutcome>;
    sync(id: string): Promise<BranchSyncOutcome>;
    branchSyncInfo(id: string): Promise<BranchSyncInfo | undefined>;
    branchSourceReady(id: string): Promise<boolean | undefined>;
    branchSyncDelta(id: string, cursor: string | null): Promise<BranchSyncPrepared>;
    applyBranchSync(id: string, delta: BranchSyncDelta): Promise<BranchSyncOutcome>;
    facts(sessions: readonly RegisteredAgentSummary[], include: readonly SessionFactName[]): Promise<readonly RegisteredAgentSummary[]>;
    search(query: SessionSearchQuery): Promise<SessionSearchResults>;
    searchShard(query: SessionSearchQuery, includePaths?: readonly string[], excludePaths?: readonly string[]): Promise<SessionSearchShard>;
    flush(): Promise<void>;
    pumpInbox(admittedSeq?: number): Promise<void>;
    snapshot(): Promise<SessionSnapshot>;
    workSchedules(agents: readonly WorkAgentFacts[]): Promise<readonly WorkScheduleFacts[]>;
    importSession(path: string, sessionId?: string): Promise<SessionImportOutcome>;
    listImportableSessions(workspace: string | undefined): Promise<ImportableSessionListing>;
    importedSourceHash(id: string, path: string): Promise<string | undefined>;
    suppressCompletion(id: string, suppress: boolean): Promise<void>;
    cut(id: string, reason: string): Promise<boolean>;
    stopWaitTargets(): Promise<readonly StopWaitTarget[]>;
    runningSubagents(parentId: string): Promise<number>;
    parkFacts(): Promise<readonly SessionParkFacts[]>;
    blockHasSession(id: string): Promise<boolean>;
    blockTreeShard(includePaths?: readonly string[], excludePaths?: readonly string[]): Promise<readonly StoredSessionTreeRow[]>;
    blockAbort(ids: readonly string[]): Promise<void>;
    blockConfirm(ids: readonly string[]): Promise<void>;
    blockWrite(request: BlockSessionRequest, ids: readonly string[]): Promise<boolean>;
    blockedIds(ids: readonly string[]): Promise<readonly string[]>;
    blockRemove(ids: readonly string[]): Promise<readonly string[]>;
    blockRelease(ids: readonly string[]): Promise<readonly string[]>;
}
