import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfiguredTuiAgentClients } from "../../../clients/tui/configured-agent-client.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { sessionPickerLists } from "../../../clients/tui/settings-picker.ts";
import { saveTuiRecentSessionId } from "../../../clients/tui/theme-preference.ts";
import { readAnnexUrlThroughHost } from "../../../src/annex/host-client.ts";
import { loadVeraConfig } from "../../../src/config.ts";
import { closeAgentThroughHost } from "../../../src/host/agent-close-client.ts";
import {
    listAgentPageThroughHost,
    listAgentsThroughHost,
} from "../../../src/host/agent-list-client.ts";
import { createAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import { requestExtensionThroughHost } from "../../../src/host/extension-request-client.ts";
import { operateModelsThroughHost } from "../../../src/host/model-operation-client.ts";
import {
    readModelSettingsThroughHost,
    refreshCatalogThroughHost,
} from "../../../src/host/model-settings-client.ts";
import { forgetProviderThroughHost } from "../../../src/host/provider-forget-client.ts";
import { startResidentHost, type ResidentHost } from "../../../src/host/runtime.ts";
import {
    importSessionThroughHost,
    listImportableSessionsThroughHost,
} from "../../../src/host/session-import-client.ts";
import { renameSessionThroughHost } from "../../../src/host/session-rename-client.ts";
import { searchSessionsThroughHost } from "../../../src/host/session-search-client.ts";
import { trashSessionThroughHost } from "../../../src/host/session-trash-client.ts";
import { VERA_HOME_ENV } from "../../../src/profile-paths.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession, type TuiTestSession } from "../../support/tui-harness.ts";

/** Files written into the home before the first launch, relative to the home. */
export interface LockedJourneyHomeFiles {
    readonly config: Record<string, unknown>;
    readonly extraFiles?: Readonly<Record<string, unknown>>;
}

export interface LockedJourneyOptions {
    readonly home: LockedJourneyHomeFiles;
    readonly width?: number;
    readonly height?: number;
}

export interface LockedJourney {
    /** The `.vera` home both the host and the TUI read and write. */
    readonly veraHome: string;
    readonly workspace: string;
    readonly configPath: string;
    /** Starts a host and a TUI on the home; the previous pair must be stopped. */
    launch(): Promise<TuiTestSession>;
    /** Quits the TUI with Ctrl+C when it is still running, then stops the host. */
    quit(): Promise<void>;
    /** Stops anything still running and deletes the home. */
    dispose(): Promise<void>;
}

// The TUI harness puts the home at `<root>/.vera`; the host must use the same one.
const HOME_DIRECTORY = ".vera";

export function createLockedJourney(options: LockedJourneyOptions): LockedJourney {
    const root = mkdtempSync(join(tmpdir(), "vera-locked-"));
    const veraHome = join(root, HOME_DIRECTORY);
    const workspace = join(root, "work");
    const configPath = join(veraHome, "config.json");
    // macOS caps socket paths near 104 bytes, and the host chmods the socket's
    // directory, so the socket gets its own short directory outside the home.
    const socketDirectory = mkdtempSync(join(tmpdir(), "vlj-"));
    const socketPath = join(socketDirectory, "h.sock");
    mkdirSync(veraHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeJson(configPath, options.home.config);
    for (const [relative, content] of Object.entries(options.home.extraFiles ?? {})) {
        writeJson(join(veraHome, relative), content);
    }

    const previousHome = process.env[VERA_HOME_ENV];
    process.env[VERA_HOME_ENV] = veraHome;
    // Keys in the developer's shell would connect real providers inside the temp home.
    const hiddenKeys = hideProviderKeys();
    // Home starts conversations in the process directory, so point it at the temp workspace.
    const previousDirectory = process.cwd();
    process.chdir(workspace);

    let host: ResidentHost | undefined;
    let tui: TuiTestSession | undefined;

    async function startHost(): Promise<ResidentHost> {
        return startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            configPath,
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(veraHome, "runtime", "host.json"),
            projectRoot: workspace,
        });
    }

    async function launch(): Promise<TuiTestSession> {
        if (host !== undefined || tui !== undefined) {
            throw new Error("Quit the running journey before launching again");
        }
        host = await startHost();
        const started = host;
        tui = await startTuiTestSession({
            home: root,
            width: options.width ?? 120,
            height: options.height ?? 40,
            dependencies: () => tuiDependencies(started, socketPath, workspace),
        });
        return tui;
    }

    async function quit(): Promise<void> {
        const running = tui;
        tui = undefined;
        try {
            if (running !== undefined) {
                running.sendKey("C-c");
                try {
                    await running.waitForSessionExit();
                } finally {
                    await running.close();
                }
            }
        } finally {
            const stopping = host;
            host = undefined;
            await stopping?.close();
            // The harness restored its own copy; keep the journey home selected.
            process.env[VERA_HOME_ENV] = veraHome;
        }
    }

    async function dispose(): Promise<void> {
        const running = tui;
        tui = undefined;
        try {
            await running?.close();
        } catch {
            // A TUI that would not close still must not keep the host alive.
        }
        const stopping = host;
        host = undefined;
        try {
            await stopping?.close();
        } finally {
            if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
            else process.env[VERA_HOME_ENV] = previousHome;
            for (const [name, value] of hiddenKeys) process.env[name] = value;
            process.chdir(previousDirectory);
            rmSync(socketDirectory, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    }

    return { veraHome, workspace, configPath, launch, quit, dispose };
}

function hideProviderKeys(): ReadonlyMap<string, string> {
    const hidden = new Map<string, string>();
    for (const [name, value] of Object.entries(process.env)) {
        if (!name.endsWith("_API_KEY") || value === undefined) continue;
        hidden.set(name, value);
        delete process.env[name];
    }
    return hidden;
}

function writeJson(path: string, content: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
}

/** The dependencies startConfiguredTui in clients/tui/main.ts builds, against an in-process host. */
async function tuiDependencies(
    host: ResidentHost,
    socketPath: string,
    workspace: string,
): Promise<TuiDependencies> {
    const agentClients = createConfiguredTuiAgentClients(() => socketPath);
    const identity = host.server.identity;
    return {
        client: createHomeClient(workspace, {
            readModelSettings: (target) => readModelSettingsThroughHost(socketPath, target),
            refreshCatalog: (provider, target) =>
                refreshCatalogThroughHost(socketPath, provider, target),
        }),
        forgetProvider: (provider, target) => forgetProviderThroughHost(socketPath, provider, target),
        operateModels: (operation, onResult, target, onStep) =>
            operateModelsThroughHost(socketPath, operation, onResult, target, onStep),
        readHostModelSettings: (target) => readModelSettingsThroughHost(socketPath, target),
        refreshHostCatalog: (provider, target) =>
            refreshCatalogThroughHost(socketPath, provider, target),
        requestExtension: (extensionId, name, payload, signal) =>
            requestExtensionThroughHost(socketPath, extensionId, name, payload, signal),
        homeHasSessions: await hostHasSessions(socketPath),
        listAgents: () => listAgentsThroughHost(socketPath),
        listSessionPage: (listOptions) => listAgentPageThroughHost(socketPath, listOptions),
        createSession: async (target) => {
            const created = await createAgentThroughHost(socketPath, target);
            return agentClients.attach(created.id);
        },
        createAgent: agentClients.create,
        branchAgent: agentClients.branch,
        syncAgentContext: agentClients.sync,
        attachAgent: agentClients.attach,
        cloneSession: agentClients.clone,
        forkSession: agentClients.fork,
        resumeSession: agentClients.resume,
        closeSession: (agentId) => closeAgentThroughHost(socketPath, agentId),
        searchSessions: (query) => searchSessionsThroughHost(socketPath, query),
        // The real client may start a new host process here; the journey owns its host instead.
        reconnectSession: (agentId) => agentClients.attach(agentId),
        onSessionEntered: (agentId) => saveTuiRecentSessionId(agentId),
        trashSession: (sessionId) => trashSessionThroughHost(socketPath, sessionId),
        renameSession: (sessionId, name) => renameSessionThroughHost(socketPath, sessionId, name),
        importSession: (path) => importSessionThroughHost(socketPath, path),
        listImportableSessions: (target) => listImportableSessionsThroughHost(socketPath, target),
        build: {
            clientVersion: "locked-journey",
            ...(identity.build_id === undefined ? {} : { hostBuildId: identity.build_id }),
            hostPid: identity.pid,
            hostStartedAt: identity.started_at,
        },
        openUsagePage: () => readAnnexUrlThroughHost(socketPath),
    };
}

/** Mirrors hostHasSessions in clients/tui/main.ts, which is not exported. */
async function hostHasSessions(socketPath: string): Promise<boolean> {
    const listed = await listAgentPageThroughHost(socketPath, { limit: 50, order: "recent" });
    return listed.agents.some((agent) => sessionPickerLists(agent));
}
