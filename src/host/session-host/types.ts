import type { VeraConfig } from "../../config.ts";
import type { ExtensionRegistry, ExtensionRegistryFailure } from "../../extensions/registry.ts";
import type { ExtensionHostServices } from "../../extensions/host-services.ts";
import type { poolReachability } from "../../model/assignment-reachability.ts";
import type { ModelAdapter } from "../../model/types.ts";
import type { AuthStorage } from "../../providers/auth-storage.ts";
import type { EmittedScheduleRun } from "../../scheduler/types.ts";
import type { ImportRoots } from "../../session-import/discover.ts";
import type { AgentRegistry, AgentRegistryOptions } from "../agent-registry.ts";
import type { HostLog } from "../host-log.ts";
import type { InboxDeliveryCoordinator } from "../inbox-delivery.ts";
import type { SessionArtifacts } from "../session-trash.ts";
import type { StartupFindings } from "../startup-findings.ts";
import type { SessionHandlers } from "./handlers.ts";
import type { RestoringSessions } from "./storage.ts";
import type { SessionShard } from "../shard.ts";
import type { WorkerGlobals } from "../master/worker-globals.ts";
import type { LeaseCredential } from "../master/leased-adapter.ts";
import type { WorkerExtensionServices } from "../master/extension-catalog.ts";

export interface SessionModelServices extends Pick<AgentRegistryOptions,
    "readAvailableModels"
    | "refreshAvailableModels"
    | "providerCatalogs"
    | "refreshableProviders"
    | "refreshCatalog"
    | "readPool"
    | "createEffortPool"
    | "readPolicy"
    | "admitToPool"
    | "removeFromPool"
    | "namePoolEntry"
    | "movePoolEntry"
    | "updateModelDefaults"
    | "contextLimit"
    | "updateContextLimit"
    | "updateApprovalDefault"
    | "writeReviewer"
    | "updateOverrides"
> {}

export interface SessionHostServices {
    readonly models: SessionModelServices;
    readonly inboxDelivery: InboxDeliveryCoordinator;
}

export type ExtensionSessionServices = Pick<ExtensionHostServices,
    "setSessionTitle" | "sendToSession" | "askSession" | "investigate"
>;

export interface StartSessionHostOptions {
    readonly sessions: "all";
    readonly sessionWorker?: boolean;
    readonly disableTurnWorker?: boolean;
    readonly workerGlobals?: WorkerGlobals;
    readonly masterCredentialLease?: LeaseCredential;
    readonly onPreferencesChanged?: () => void;
    readonly poolMaster?: boolean;
    readonly remoteExtensions?: WorkerExtensionServices;
    readonly config: VeraConfig;
    readonly currentConfig: () => VeraConfig;
    readonly currentReachability: () => ReturnType<typeof poolReachability>;
    readonly home: string;
    readonly configPath: string;
    readonly cacheDirectory: string;
    readonly sessionDirectory: string;
    readonly restoringSessions?: RestoringSessions;
    readonly shard?: SessionShard;
    readonly sessionIdentityReservationRoot: string;
    readonly blockedDirectory: string;
    readonly modelFailureLedgerPath: string;
    readonly permissionPreferencesPath?: string;
    readonly eventLogDirectory?: string;
    readonly importRoots?: ImportRoots;
    readonly createAdapter?: () => ModelAdapter;
    readonly authStorage: AuthStorage;
    readonly hostLog: HostLog;
    readonly startupLog: HostLog;
    readonly startupFindings: StartupFindings;
    readonly timed: <T>(phase: string, run: () => T | Promise<T>) => Promise<T>;
    readonly onExtensionFailure?: (failure: ExtensionRegistryFailure) => void;
    readonly trashSessionArtifacts?: (artifacts: SessionArtifacts) => Promise<void>;
    readonly createServices: (createAdapter: AgentRegistryOptions["createAdapter"], sessionWorker?: boolean) => SessionHostServices;
    readonly turnsHeld: () => boolean;
    readonly inboxActorForSession: () => string | null;
    readonly annexUrl: () => string | undefined;
    readonly forgetRestartRecords: (sessionId: string) => void;
    readonly recentScheduleRuns: () => readonly EmittedScheduleRun[];
    readonly onWorkChanged: (listener: () => void) => () => void;
}

export interface SessionHost {
    readonly registry: AgentRegistry;
    readonly extensions: ExtensionRegistry;
    readonly handlers: SessionHandlers;
    readonly createAdapter: AgentRegistryOptions["createAdapter"];
    readonly localExtensionSessions: ExtensionSessionServices;
    readonly inboxDelivery: InboxDeliveryCoordinator;
    setExtensionSessions(services: ExtensionSessionServices): void;
    setParkIdle(park: () => Promise<void>): void;
    // The resident host starts the scan after publishing its listener.
    startStorage(options?: { readonly scan?: boolean }): void;
    stopMaintenance(): void;
    clearProviderSelection(provider: string): Promise<void>;
    closeAfterStartupFailure(): Promise<void>;
    close(): Promise<void>;
}
