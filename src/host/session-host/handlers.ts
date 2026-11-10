import type { HostLog } from "../host-log.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import { basename } from "node:path";
import { belongsToSessionShard, type SessionShard } from "../shard.ts";
import { orderByExtension, type WorkerExtensionServices } from "../pool/extension-catalog.ts";

import type { ExtensionRegistry } from "../../extensions/registry.ts";
import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import {
    ImportableSessionScanner,
    importRootsFrom,
    type ImportRoots,
} from "../../session-import/discover.ts";
import {
    NO_SEARCH_RESULTS,
    searchSessionShard,
    searchSessions,
    type SessionSearchQuery,
    type SessionSearchShard,
} from "../../store/session-search.ts";
import {
    type AgentRegistry,
    renameStoredSession,
    type RenameSessionOutcome,
    type RegisteredAgentSummary,
} from "../agent-registry.ts";
import type { ClosedMember } from "../agent-registry/support.ts";
import type { ExtensionLoadFailure } from "../protocol.ts";
import type { ResidentAgent } from "../resident-agent.ts";
import { createSessionBlockService, type SessionBlockService } from "../session-block-service.ts";
import {
    importSessionFile,
    markImportedSessions,
    type SessionImportOutcome,
} from "../session-import-service.ts";
import { buildWorkIndex, type WorkAgentFacts, type WorkIndexSnapshot, type WorkScheduleFacts } from "../work-index.ts";

import type { CloseAgentOutcome, StartHostServerOptions } from "../server.ts";
import {
    commandSessionPath,
    enrichSessionsWithFacts,
    findOrRestoreAgent, indexClosedMembers,
    indexStoredSession,
    mergeStoredAndResidentAgents,
    resumeOrFind,
    resumeReserved,
    storedSessionExists, storedSessionPath,
    withSessionReservation,
    type RestoringSessions,
} from "./storage.ts";

export interface SessionHandlers extends Required<Pick<StartHostServerOptions,
    "findAgent"
    | "readAgentTree"
    | "handleExtensionRequest"
    | "readModelSettings"
    | "refreshCatalog"
    | "readExtensionLoadFailures"
    | "listAgents"
    | "readSessionFacts"
    | "listBackgroundAgents"
    | "readWorkIndex"
    | "searchSessions"
    | "onRosterChanged"
    | "createAgent"
    | "resumeAgent"
    | "branchAgent"
    | "discardBranch"
    | "commitBranch"
    | "syncAgentContext"
    | "trashSession"
    | "closeAgent"
    | "blockSession"
    | "unblockSession"
    | "renameSession"
    | "importSession"
    | "listImportableSessions"
    | "readExtensionState"
    | "listExtensionCommands"
    | "runExtensionCommand"
    | "canShutdown"
    | "canReplace"
    | "onAgentStartFailure"
>> {
    readonly createAgent: (...args: Parameters<NonNullable<StartHostServerOptions["createAgent"]>>) => Promise<ResidentAgent>;
    readonly importSession: (path: string, sessionId?: string) => Promise<SessionImportOutcome>;
    readonly resumeAgent: (sessionPath: string, ownershipTransfer?: boolean) => Promise<ResidentAgent>;
    readonly resumeAgentReserved: (sessionPath: string, ownershipTransfer?: boolean) => Promise<ResidentAgent>;
    readonly findAgentReserved: (agentId: string) => Promise<ResidentAgent | undefined>;
    readonly storedSessionPath: (agentId: string) => Promise<string | undefined>;
    readonly renameSessionReserved: (agentId: string, name: string | null) => Promise<RenameSessionOutcome>;
    readonly trashSessionReserved: (agentId: string) => Promise<"trashed" | "busy" | "not_found" | "failed">;
    readonly releaseAgent: (id: string) => Promise<CloseAgentOutcome>;
    readonly searchShard: (query: SessionSearchQuery, includePaths?: readonly string[], excludePaths?: readonly string[]) => Promise<SessionSearchShard>;
    readonly workSchedules: (agents: readonly WorkAgentFacts[]) => readonly WorkScheduleFacts[];
    readonly setImportedSourceHash: (reader: ((summary: RegisteredAgentSummary) => Promise<string | undefined>) | undefined) => void;
    readonly blockParts: SessionBlockService;
    readonly recordTrashOutcome: (rootId: string, closed: readonly ClosedMember[], trashed: boolean) => Promise<void>;
    readonly recordClosedMembers: (closed: readonly ClosedMember[]) => Promise<void>;
    readonly rememberStored: (summary: RegisteredAgentSummary) => void;
    readonly forgetStored: (id: string) => void;
}

interface SessionHandlerOptions {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly remoteExtensions?: WorkerExtensionServices;
    readonly extensionLoadFailures: readonly ExtensionLoadFailure[];
    readonly sessionDirectory: string;
    readonly restoringSessions?: RestoringSessions;
    readonly shard?: SessionShard;
    readonly blockedDirectory: string;
    readonly modelFailureLedgerPath: string;
    readonly storedSessionIndex: Map<string, RegisteredAgentSummary>;
    readonly storedSessions: Promise<ReadonlyMap<string, RegisteredAgentSummary>>;
    readonly importRoots?: ImportRoots;
    readonly eventLogPathForId?: (agentId: string, cwd: string) => string;
    readonly forgetRestartRecords: (sessionId: string) => void | Promise<void>;
    readonly recentScheduleRuns: () => readonly EmittedScheduleRun[];
    readonly onWorkChanged: (listener: () => void) => () => void;
    readonly hostLog: HostLog;
}

export function createSessionHandlers(options: SessionHandlerOptions): SessionHandlers {
    const { registry, extensions, extensionLoadFailures, sessionDirectory, blockedDirectory,
        modelFailureLedgerPath, storedSessionIndex, storedSessions, eventLogPathForId,
        forgetRestartRecords, recentScheduleRuns, onWorkChanged, hostLog } = options;
    const restoringSessions = options.restoringSessions ?? new Map();
    const resumeSession = (sessionPath: string, ownershipTransfer = false) =>
        resumeOrFind(registry, sessionPath, restoringSessions, ownershipTransfer);
    const resumeSessionReserved = (sessionPath: string, ownershipTransfer = false) =>
        resumeReserved(registry, sessionPath, ownershipTransfer);
    const findSession = (agentId: string, resume: (path: string) => Promise<ResidentAgent>) =>
        findOrRestoreAgent(registry, agentId, sessionDirectory, storedSessions, resume);
    const importableSessions = new ImportableSessionScanner(options.importRoots ?? importRootsFrom(process.env));
    const sessionBlocks = createSessionBlockService({ registry, sessionDirectory, blockedDirectory });
    let workIndexThisTurn: WorkIndexSnapshot | undefined;
    // Imports run one at a time so two requests for one file cannot both write.
    let importQueue: Promise<void> = Promise.resolve();
    let importedSourceHash: ((summary: RegisteredAgentSummary) => Promise<string | undefined>) | undefined;
    const withTarget = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
        const path = registry.agents.get(id)?.store.path
            ?? await storedSessionPath(id, sessionDirectory, await storedSessions);
        if (path === undefined) return await run();
        let entered = false;
        try {
            return await withSessionReservation(path, restoringSessions, async () => {
                entered = true;
                return await run();
            });
        } catch (error) {
            if (!entered && (error as NodeJS.ErrnoException).code === "ENOENT") return await run();
            throw error;
        }
    };
    const trashSessionReserved = async (targetId: string): Promise<"trashed" | "busy" | "not_found" | "failed"> => {
        const resident = await registry.trashSession(targetId);
        if (resident === "trashed") {
            storedSessionIndex.delete(targetId);
            const forgotten = forgetRestartRecords(targetId);
            if (forgotten !== undefined) await forgotten;
        }
        if (resident !== "not_found") return resident;
        const stored = await registry.trashStoredSession(targetId, async () => {
            const sessionPath = await storedSessionPath(targetId, sessionDirectory, await storedSessions);
            if (sessionPath === undefined) return undefined;
            const workspace = storedSessionIndex.get(targetId)?.workspace;
            return {
                sessionPath,
                attachmentsPath: `${sessionPath}.attachments`,
                ...(eventLogPathForId === undefined || workspace === undefined
                    ? {} : { eventLogPath: eventLogPathForId(targetId, workspace) }),
            };
        });
        if (stored === "trashed") {
            storedSessionIndex.delete(targetId);
            const forgotten = forgetRestartRecords(targetId);
            if (forgotten !== undefined) await forgotten;
        }
        return stored;
    };
    const renameSessionReserved = async (targetId: string, name: string | null): Promise<RenameSessionOutcome> => {
        const resident = await registry.renameSession(targetId, name);
        if (resident.status !== "not_found") return resident;
        const sessionPath = await storedSessionPath(targetId, sessionDirectory, await storedSessions);
        if (sessionPath === undefined) return { status: "not_found" };
        const renamed = await renameStoredSession(sessionPath, name);
        if (renamed.status === "renamed") await indexStoredSession(sessionPath, storedSessionIndex);
        return renamed;
    };
    const closeSession = async (targetId: string, reason?: SessionEndReason, transfer = false): Promise<CloseAgentOutcome> => {
        const outcome = transfer
            ? await registry.releaseAgentTree(targetId)
            : await registry.closeAgentTree(targetId, reason);
        if (outcome.status === "busy") return { status: "busy" } as const;
        if (outcome.status === "closed" && outcome.sessionRetained) {
            await indexClosedMembers(registry, outcome.closed, storedSessionIndex);
        }
        if (outcome.status === "closed") {
            return { status: "closed", sessionRetained: outcome.sessionRetained } as const;
        }
        return await storedSessionExists(targetId, sessionDirectory, storedSessionIndex)
            ? { status: "closed", sessionRetained: true } as const
            : { status: "not_found" } as const;
    };
    return {
        blockParts: sessionBlocks,
        rememberStored(summary) {
            if (!storedSessionIndex.has(summary.id)) storedSessionIndex.set(summary.id, summary);
        },
        forgetStored(id) {
            storedSessionIndex.delete(id);
        },
        async recordClosedMembers(closed) {
            await indexClosedMembers(registry, closed, storedSessionIndex);
            registry.notifyRosterChanged();
        },
        async recordTrashOutcome(rootId, closed, trashed) {
            await indexClosedMembers(registry, trashed ? closed.filter((member) => member.id !== rootId) : closed, storedSessionIndex).catch(() => {});
            if (trashed) {
                storedSessionIndex.delete(rootId);
                const forgotten = forgetRestartRecords(rootId);
                if (forgotten !== undefined) await forgotten;
            }
            registry.notifyRosterChanged();
        },
        findAgent: (agentId) => findSession(agentId, resumeSession),
        findAgentReserved: (agentId) => findSession(agentId, resumeSessionReserved),
        storedSessionPath: async (agentId) =>
            storedSessionPath(agentId, sessionDirectory, await storedSessions),
        readAgentTree: (agentId) => registry.ownedTreeIds(agentId),
        handleExtensionRequest: (extensionId, name, payload, signal) =>
            extensions.handleRequest(extensionId, name, payload, signal),
        readModelSettings: (workspace) =>
            registry.readHostModelSettings(workspace),
        refreshCatalog: async (provider, workspace) => {
            const refreshed = await registry.refreshHostCatalog(provider);
            if (refreshed === undefined) return undefined;
            return registry.readHostModelSettings(workspace);
        },
        readExtensionLoadFailures: () => extensionLoadFailures,
        listAgents: async () => mergeStoredAndResidentAgents(
            await storedSessions,
            registry.list(),
        ),
        readSessionFacts: (sessions, include) =>
            enrichSessionsWithFacts(
                sessions,
                include,
                modelFailureLedgerPath,
                registry.availableModels,
            ),
        listBackgroundAgents: () => registry.list(),
        readWorkIndex: () => {
            if (workIndexThisTurn !== undefined) {
                return workIndexThisTurn;
            }
            const agents = registry.workFacts();
            workIndexThisTurn = buildWorkIndex(
                agents,
                registry.scheduleWorkFacts(recentScheduleRuns(), agents),
            );
            queueMicrotask(() => {
                workIndexThisTurn = undefined;
            });
            return workIndexThisTurn;
        },
        workSchedules: (agents) => registry.scheduleWorkFacts(recentScheduleRuns(), agents),
        searchSessions: async (query) => {
            if (query.session_id === undefined) {
                return searchSessions(sessionDirectory, query);
            }
            const resident = registry.list().find(
                (session) => session.id === query.session_id,
            );
            const stored = resident === undefined
                ? (await storedSessions).get(query.session_id)
                : undefined;
            const sessionPath = resident?.session_path ?? stored?.session_path;
            return sessionPath === undefined
                ? NO_SEARCH_RESULTS
                : searchSessions(sessionDirectory, query, { sessionPath });
        },
        searchShard: (query, includePaths, excludePaths) => searchSessionShard(sessionDirectory, query, {
            ...(includePaths === undefined ? {} : { includePaths }),
            ...(excludePaths === undefined ? {} : { excludePaths }),
            ...(options.shard === undefined ? {} : { includeUnindexedPath: (path: string) => {
                const name = basename(path);
                return name.endsWith(".jsonl") && belongsToSessionShard(name.slice(0, -6), options.shard!);
            } }),
        }),
        onRosterChanged: (listener) => {
            const stopRoster = registry.onRosterChanged(listener);
            const stopWork = onWorkChanged(listener);
            return (): void => {
                stopRoster();
                stopWork();
            };
        },
        createAgent: (createOptions) => registry.create(createOptions),
        resumeAgent: resumeSession,
        resumeAgentReserved: resumeSessionReserved,
        branchAgent: (options) => registry.branch(options),
        discardBranch: async (agentId) => {
            await registry.trashSession(agentId);
        },
        commitBranch: (agentId) => registry.commitBranch(agentId),
        syncAgentContext: (agentId) => registry.syncBranchContext(agentId),
        trashSession: (targetId) => withTarget(targetId, () => trashSessionReserved(targetId)),
        trashSessionReserved,
        closeAgent: (targetId, reason) => closeSession(targetId, reason),
        releaseAgent: (targetId) => closeSession(targetId, undefined, true),
        blockSession: (request) => sessionBlocks.block(request),
        unblockSession: (request) => sessionBlocks.unblock(request),
        renameSession: (targetId, name) => withTarget(targetId, () => renameSessionReserved(targetId, name)),
        renameSessionReserved,
        importSession: (path, sessionId) => {
            const run = importQueue.then(async () => {
                await storedSessions;
                const outcome = await importSessionFile(path, {
                    sessionDirectory,
                    indexed: storedSessionIndex.values(),
                    ...(sessionId === undefined ? {} : { createSessionId: () => sessionId }),
                    ...(importedSourceHash === undefined ? {} : { importedSourceHash }),
                });
                if (outcome.status === "imported" && !outcome.existing) {
                    await indexStoredSession(
                        outcome.sessionPath,
                        storedSessionIndex,
                    );
                }
                return outcome;
            });
            importQueue = run.then(() => undefined, () => undefined);
            return run;
        },
        setImportedSourceHash: (reader) => { importedSourceHash = reader; },
        listImportableSessions: async (workspace) => {
            const listed = await importableSessions.list(workspace);
            await storedSessions;
            return markImportedSessions(listed, storedSessionIndex.values());
        },
        readExtensionState: (sessionId) => extensions.sessionState(sessionId),
        listExtensionCommands: () => options.remoteExtensions === undefined ? extensions.commands()
            : orderByExtension(options.remoteExtensions.catalog.extensionOrder,
                [...extensions.commands(), ...options.remoteExtensions.catalog.commandCatalog], (command) => command.source),
        runExtensionCommand: (
            name,
            argumentsText,
            workspace,
            signal,
            sessionId,
        ) => {
            const path = sessionId === undefined ? undefined
                : commandSessionPath(registry, sessionId, sessionDirectory, storedSessionIndex);
            if (options.remoteExtensions?.catalog.commandCatalog.some((command) => command.name === name)) {
                return options.remoteExtensions.invokeCommand(name, argumentsText, workspace, signal, sessionId, path);
            }
            return extensions.invokeCommand(name, argumentsText, workspace, signal, sessionId, path);
        },
        canShutdown: () => registry.idleForShutdown(),
        canReplace: () => registry.idleForReplacement(),
        onAgentStartFailure: (operation, error) => hostLog({
            type: "agent_start_failed",
            operation,
            ...hostErrorFields(error),
        }),
    };
}

function hostErrorFields(error: unknown): Record<string, unknown> {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
        error_name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === "string" ? { code } : {}),
    };
}

