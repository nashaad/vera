import type { HostLog } from "../host-log.ts";

import type { ExtensionRegistry } from "../../extensions/registry.ts";
import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import {
    ImportableSessionScanner,
    importRootsFrom,
    type ImportRoots,
} from "../../session-import/discover.ts";
import {
    NO_SEARCH_RESULTS,
    searchSessions,
} from "../../store/session-search.ts";
import {
    type AgentRegistry,
    renameStoredSession,
    type RegisteredAgentSummary,
} from "../agent-registry.ts";
import type { ExtensionLoadFailure } from "../protocol.ts";
import type { ResidentAgent } from "../resident-agent.ts";
import { createSessionBlockService } from "../session-block-service.ts";
import {
    importSessionFile,
    markImportedSessions,
} from "../session-import-service.ts";
import { buildWorkIndex, type WorkIndexSnapshot } from "../work-index.ts";

import type { StartHostServerOptions } from "../server.ts";
import {
    commandSessionPath,
    enrichSessionsWithFacts,
    findOrRestoreAgent, indexClosedMembers,
    indexStoredSession,
    mergeStoredAndResidentAgents,
    resumeOrFind,
    storedSessionExists, storedSessionPath,
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
    readonly resumeAgent: (sessionPath: string) => Promise<ResidentAgent>;
}

interface SessionHandlerOptions {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly extensionLoadFailures: readonly ExtensionLoadFailure[];
    readonly sessionDirectory: string;
    readonly blockedDirectory: string;
    readonly modelFailureLedgerPath: string;
    readonly storedSessionIndex: Map<string, RegisteredAgentSummary>;
    readonly storedSessions: Promise<ReadonlyMap<string, RegisteredAgentSummary>>;
    readonly importRoots?: ImportRoots;
    readonly eventLogPathForId?: (agentId: string, cwd: string) => string;
    readonly forgetRestartRecords: (sessionId: string) => void;
    readonly recentScheduleRuns: () => readonly EmittedScheduleRun[];
    readonly onWorkChanged: (listener: () => void) => () => void;
    readonly hostLog: HostLog;
}

export function createSessionHandlers(options: SessionHandlerOptions): SessionHandlers {
    const { registry, extensions, extensionLoadFailures, sessionDirectory, blockedDirectory,
        modelFailureLedgerPath, storedSessionIndex, storedSessions, eventLogPathForId,
        forgetRestartRecords, recentScheduleRuns, onWorkChanged, hostLog } = options;
    const restoringSessions = new Map<string, Promise<ResidentAgent>>();
    const resumeSession = (sessionPath: string) => resumeOrFind(registry, sessionPath, restoringSessions);
    const importableSessions = new ImportableSessionScanner(options.importRoots ?? importRootsFrom(process.env));
    const sessionBlocks = createSessionBlockService({ registry, sessionDirectory, blockedDirectory });
    let workIndexThisTurn: WorkIndexSnapshot | undefined;
    // Imports run one at a time so two requests for one file cannot both write.
    let importQueue: Promise<void> = Promise.resolve();
    return {
        findAgent: (agentId) => findOrRestoreAgent(
            registry,
            agentId,
            sessionDirectory,
            storedSessions,
            resumeSession,
        ),
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
        branchAgent: (options) => registry.branch(options),
        discardBranch: async (agentId) => {
            await registry.trashSession(agentId);
        },
        commitBranch: (agentId) => registry.commitBranch(agentId),
        syncAgentContext: (agentId) => registry.syncBranchContext(agentId),
        trashSession: async (targetId) => {
            const resident = await registry.trashSession(targetId);
            if (resident === "trashed") {
                storedSessionIndex.delete(targetId);
                forgetRestartRecords(targetId);
            }
            if (resident !== "not_found") return resident;
            const stored = await registry.trashStoredSession(
                targetId,
                async () => {
                    const sessionPath = await storedSessionPath(
                        targetId,
                        sessionDirectory,
                        await storedSessions,
                    );
                    if (sessionPath === undefined) return undefined;
                    const workspace = storedSessionIndex.get(targetId)
                        ?.workspace;
                    return {
                        sessionPath,
                        attachmentsPath: `${sessionPath}.attachments`,
                        ...(eventLogPathForId === undefined
                            || workspace === undefined
                            ? {}
                            : {
                                eventLogPath: eventLogPathForId(
                                    targetId,
                                    workspace,
                                ),
                            }),
                    };
                },
            );
            if (stored === "trashed") {
                storedSessionIndex.delete(targetId);
                forgetRestartRecords(targetId);
            }
            return stored;
        },
        closeAgent: async (targetId, reason) => {
            const outcome = await registry.closeAgentTree(targetId, reason);
            if (outcome.status === "busy") {
                return { status: "busy" };
            }
            if (outcome.status === "closed" && outcome.sessionRetained) {
                await indexClosedMembers(
                    registry,
                    outcome.closed,
                    storedSessionIndex,
                );
            }
            if (outcome.status === "closed") {
                return {
                    status: "closed",
                    sessionRetained: outcome.sessionRetained,
                };
            }
            return await storedSessionExists(
                targetId,
                sessionDirectory,
                storedSessionIndex,
            )
                ? { status: "closed", sessionRetained: true }
                : { status: "not_found" };
        },
        blockSession: (request) => sessionBlocks.block(request),
        unblockSession: (request) => sessionBlocks.unblock(request),
        renameSession: async (targetId, name) => {
            const resident = await registry.renameSession(targetId, name);
            if (resident.status !== "not_found") return resident;
            const sessionPath = await storedSessionPath(
                targetId,
                sessionDirectory,
                await storedSessions,
            );
            if (sessionPath === undefined) {
                return { status: "not_found" };
            }
            const renamed = await renameStoredSession(sessionPath, name);
            if (renamed.status === "renamed") {
                await indexStoredSession(sessionPath, storedSessionIndex);
            }
            return renamed;
        },
        importSession: (path) => {
            const run = importQueue.then(async () => {
                await storedSessions;
                const outcome = await importSessionFile(path, {
                    sessionDirectory,
                    indexed: storedSessionIndex.values(),
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
        listImportableSessions: async (workspace) => {
            const listed = await importableSessions.list(workspace);
            await storedSessions;
            return markImportedSessions(listed, storedSessionIndex.values());
        },
        readExtensionState: (sessionId) => extensions.sessionState(sessionId),
        listExtensionCommands: () => extensions.commands(),
        runExtensionCommand: (
            name,
            argumentsText,
            workspace,
            signal,
            sessionId,
        ) => extensions.invokeCommand(
            name,
            argumentsText,
            workspace,
            signal,
            sessionId,
            sessionId === undefined
                ? undefined
                : commandSessionPath(
                    registry,
                    sessionId,
                    sessionDirectory,
                    storedSessionIndex,
                ),
        ),
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

