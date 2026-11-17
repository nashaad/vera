import { listProvidersThroughHost, loginProviderThroughHost, saveProviderThroughHost, selectProviderModelThroughHost } from "../../../src/host/provider-sign-in-client.ts";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type WebContents } from "electron";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { requestExtensionThroughHost } from "../../../src/host/extension-request-client.ts";
import { AgentStartError, createAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import { moveSessionThroughHost } from "../../../src/host/session-move-client.ts";
import { setSessionArchivedThroughHost } from "../../../src/host/session-archive-client.ts";
import { checkFile, prepareFiles } from "../../../src/attachments/files.ts";
import { FILE_COUNT_LIMIT } from "../../../src/attachments/file-limits.ts";
import { selectedVeraHome } from "../../../src/profile-paths.ts";
import type {
    BranchSessionResult,
    CloseSessionResult,
    CreateSessionResult,
    DesktopEvent,
    FilePreview,
    FolderListing,
    OpenSidekickResult,
    SyncSidekickResult,
} from "../../ui/src/protocol/bridge.ts";
import { NO_PINS } from "../../ui/src/protocol/pins.ts";
import type { MoveSessionOutcome } from "../../ui/src/protocol/sessionMove.ts";
import type { ExtensionCommandResult } from "../../ui/src/protocol/extension-commands.ts";
import { hiddenCommandsFor, parseHiddenIds } from "../../ui/src/state/surfaces.ts";
import { DEFAULT_THEME, importedThemeSlug, isThemeChoice, type ThemeChoice } from "../../ui/src/theme/tokens.ts";
import { annexAddress, readAnnexPages } from "./annex-requests.ts";
import { buildMenuTemplate } from "./app-menu.ts";
import { BrowserPane } from "./browser/pane.ts";
import { BrowserCdp } from "./browser/cdp.ts";
import { BrowserGateway } from "./browser/gateway.ts";
import { AssignmentService } from "./assignments.ts";
import { BootSession, type BootPreflight } from "./boot.ts";
import { bundledInstallPreflight } from "./install-preflight.ts";
import { CHANNELS } from "./channels.ts";
import { DEFAULT_DESKTOP_FLAGS, FlagsStore, flagsPath } from "./desktop-flags.ts";
import { CATALOG_TASK_FILE, CATALOG_TASK_SERVICE, parseCatalogReply, type CatalogTask } from "./extension-catalog/task-protocol.ts";
import { EXTENSION_TASK_FILE, EXTENSION_TASK_SERVICE, parseInstallReply, type InstallTask } from "./extension-install/task-protocol.ts";
import { catalogAddress } from "./extensions/catalog-address.ts";
import { ExtensionCatalogService } from "./extensions/catalog-service.ts";
import { registerExtensionHandlers } from "./extensions/ipc.ts";
import { migrateSavedThemes } from "./extensions/migrate.ts";
import { extensionsDirectory, extensionStatePath, includedExtensionsDirectory } from "./extensions/paths.ts";
import { ExtensionService } from "./extensions/service.ts";
import { ExtensionStateStore } from "./extensions/state.ts";
import { ExtensionStore } from "./extensions/store.ts";
import { existingFolders, folderListArgument } from "./folder-existence.ts";
import { readFilePreview } from "./file-preview.ts";
import { listFolder, pathArgument } from "./folder-listing.ts";
import { readBranch } from "./git-branch.ts";
import { HostPipe } from "./host-pipe.ts";
import { LayoutStore, layoutPath } from "./layout-store.ts";
import { ASSIGNMENT_TASK_FILE, ASSIGNMENT_TASK_SERVICE, changeArgument, parseAssignmentTaskReply, type AssignmentTask } from "./model-assignments/task-protocol.ts";
import { modelArgument, providerArgument } from "./model-arguments.ts";
import {
    forgetProvider,
    operateModel,
    operationArgument,
    readModels,
    refreshProvider,
    workspaceArgument,
} from "./model-requests.ts";
import { pastedImageDirectory, savePastedImage } from "./pasted-image.ts";
import { PinStore, pinsPath } from "./pin-store.ts";
import { BUNDLED_RELEASE_DIRECTORY } from "./release-install.ts";
import { readExtensionFailures } from "./extension-requests.ts";
import { readNewSessionAgents } from "./agent-requests.ts";
import { readFolderCustomizations } from "./customization-requests.ts";
import { searchArgument, searchSessions } from "./search-requests.ts";
import { moveSessionToFolder } from "./session-move.ts";
import { SessionPanes } from "./session-panes.ts";
import { branchSession, cloneSession, closeSession, idArgument } from "./session-requests.ts";
import { openSidekick, syncSidekick } from "./sidekick-requests.ts";
import { shortcutCommand } from "./shortcuts.ts";
import { startTaskProcess } from "./tasks/process.ts";
import { TaskRunner } from "./tasks/runner.ts";
import { ExtensionCommandService } from "./extension-commands/service.ts";
import { browserFrame, PageCommandService } from "./extension-commands/page.ts";
import { parseCommandReply, type CommandReply, type CommandTask } from "./extension-commands/task-protocol.ts";
import { ThemeService } from "./theme-service.ts";
import { themesDirectory } from "./theme-store.ts";
import { parseWindowBackground } from "./window-background.ts";

const MAX_SEND_BYTES = 1_048_576;
const MAX_AGENT_ID_CHARS = 256;
const TRAFFIC_LIGHT_INSET_X = 14;
const TRAFFIC_LIGHT_SIZE = 14;
const TITLE_BAR_HEIGHT_RANGE = { min: 24, max: 96 };
// Matches the page's header height at the default density; the page reports the real one on load.
const TITLE_BAR_HEIGHT_INITIAL = 39;

// Chromium's default userData sits outside VERA_HOME; keep a trial home self-contained.
const userData = join(selectedVeraHome(), "machine", "desktop", "chromium");
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);

let window: BrowserWindow | undefined;
let boot: BootSession | undefined;
let stopping = false;
let activeTheme: ThemeChoice = DEFAULT_THEME;
// Set from the ready event; cleared on disconnect, failure, a new boot, or app stop.
let hostSocketPath: string | undefined;
// The annex base URL from the last page list the window read; the browser frame may only load from it.
let annexUrl: string | undefined;
let browserPane: BrowserPane | undefined;
let browserGateway: BrowserGateway | undefined;
let browserClearing: Promise<void> | undefined;

const pipe = new HostPipe(sendEvent);
const flagsStore = new FlagsStore(flagsPath(selectedVeraHome()), app.isPackaged);
// With Reasoning off the window asks the host for a character count in place of the reasoning text.
const hidesReasoning = (): boolean => flagsStore.read().showReasoning !== "on";
const sessionPanes = new SessionPanes(sendEvent, hidesReasoning);
const layoutStore = new LayoutStore(layoutPath(selectedVeraHome()));
const pinStore = new PinStore(pinsPath(selectedVeraHome()));
// Until the window reports, the menus hide every part the flags file does not turn on.
let hiddenCommands: ReadonlySet<string> = hiddenCommandsFor(flagsStore.read());
const assignmentTasks = new TaskRunner(() => startTaskProcess<AssignmentTask>(ASSIGNMENT_TASK_FILE, ASSIGNMENT_TASK_SERVICE), parseAssignmentTaskReply);
const assignments = new AssignmentService(selectedVeraHome(), (task) => assignmentTasks.run(task));
const extensionStore = new ExtensionStore(
    extensionsDirectory(selectedVeraHome()),
    new ExtensionStateStore(extensionStatePath(selectedVeraHome())),
    includedExtensionsDirectory(import.meta.dirname),
);
const themeService = new ThemeService(extensionStore, themesDirectory(selectedVeraHome()), () => installMenu());
const installTasks = new TaskRunner(() => startTaskProcess<InstallTask>(EXTENSION_TASK_FILE, EXTENSION_TASK_SERVICE), parseInstallReply);
const extensionService = new ExtensionService(extensionStore, themeService, (task) => installTasks.run(task), () => installMenu());
const catalogTasks = new TaskRunner(() => startTaskProcess<CatalogTask>(CATALOG_TASK_FILE, CATALOG_TASK_SERVICE), parseCatalogReply);
const extensionCatalog = new ExtensionCatalogService(catalogAddress(), extensionStore, extensionService, (task) => catalogTasks.run(task));

// One runner per worker file, so runs of the same worker go one at a time.
const commandRunners = new Map<string, TaskRunner<CommandTask, CommandReply>>();
const pageCommands = new PageCommandService();
const extensionCommands = new ExtensionCommandService(
    {
        target: (command) => extensionStore.commandTarget(command),
        run: (target, task) => {
            const key = `${target.taskFile}\n${target.taskTitle}`;
            const runner = commandRunners.get(key)
                ?? new TaskRunner<CommandTask, CommandReply>(() => startTaskProcess<CommandTask>(target.taskFile, target.taskTitle), parseCommandReply);
            commandRunners.set(key, runner);
            return runner.run(task);
        },
        chooseFile: async (filter) => {
            if (window === undefined) return undefined;
            const result = await dialog.showOpenDialog(window, {
                properties: ["openFile"],
                filters: [{ name: filter.label, extensions: [...filter.extensions] }],
            });
            return result.canceled ? undefined : result.filePaths[0];
        },
    },
    themeService,
);

function sendEvent(event: DesktopEvent): void {
    if (window === undefined || window.isDestroyed()) return;
    window.webContents.send(CHANNELS.event, event);
}

function receiveEvent(event: DesktopEvent): void {
    sendEvent(event);
    if (event.type === "ready") {
        hostSocketPath = event.socketPath;
        pipe.connect(event.socketPath);
        browserGateway?.start(event.socketPath);
        sessionPanes.connect(event.socketPath);
    } else if (event.type === "disconnected" || event.type === "failed") {
        hostSocketPath = undefined;
        browserGateway?.stop();
    }
}

function startBoot(): void {
    boot?.cancel();
    hostSocketPath = undefined;
    browserGateway?.stop();
    pipe.close();
    sessionPanes.close();
    boot = new BootSession(selectedVeraHome(), receiveEvent, installPreflight());
    boot.start();
}

// Only the packaged app carries a release; a development run uses its checkout's Vera.
function installPreflight(): BootPreflight | undefined {
    if (!app.isPackaged || (process.env.VERA_DESKTOP_DEV_CLI ?? "").trim().length > 0) return undefined;
    return bundledInstallPreflight(join(process.resourcesPath, BUNDLED_RELEASE_DIRECTORY));
}

// Rebuilt when the page reports a theme or the imported themes change, so the View menu lists and checks them.
function installMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(
        buildMenuTemplate(process.platform, (id) => sendEvent({ type: "command", id }), activeTheme, themeService.themes(), hiddenCommands, extensionStore.menu("theme")),
    ));
}

// Clears what an interrupted install left, then moves themes saved before desktop extensions into extensions.
function startExtensions(): void {
    try {
        extensionStore.clearStaging();
        migrateSavedThemes(extensionStore, themesDirectory(selectedVeraHome()));
    } catch {
        // A theme that did not move stays in the old folder and stays usable.
    }
}

function shutdown(): void {
    if (stopping) return;
    stopping = true;
    browserGateway?.stop();
    pageCommands.stop();
    browserPane?.dispose();
    browserPane = undefined;
    boot?.cancel();
    boot = undefined;
    hostSocketPath = undefined;
    pipe.close();
    sessionPanes.close();
}

async function chooseFolder(parent: BrowserWindow): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(parent, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
}

function fromWindow(event: { readonly sender: WebContents }): boolean {
    return window !== undefined && event.sender === window.webContents;
}

function onAnnex(url: string): boolean {
    if (url === "about:blank" || url === "about:srcdoc") return true;
    if (annexUrl === undefined) return false;
    try {
        return new URL(url).origin === new URL(annexUrl).origin;
    } catch {
        return false;
    }
}

function trafficLightPosition(titleBarHeight: number): { x: number; y: number } {
    return {
        x: TRAFFIC_LIGHT_INSET_X,
        y: Math.max(0, Math.round((titleBarHeight - TRAFFIC_LIGHT_SIZE) / 2)),
    };
}

function createWindow(): BrowserWindow {
    const created = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 720,
        minHeight: 480,
        show: false,
        title: "Vera",
        // The page draws its own header on macOS; other platforms keep the system title bar.
        ...(process.platform === "darwin"
            ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLightPosition(TITLE_BAR_HEIGHT_INITIAL) }
            : {}),
        webPreferences: {
            preload: join(import.meta.dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    created.once("ready-to-show", () => created.show());
    const sendShown = (): void => sendEvent({ type: "window_shown", shown: created.isVisible() && !created.isMinimized() });
    created.on("show", sendShown);
    created.on("hide", sendShown);
    created.on("minimize", sendShown);
    created.on("restore", sendShown);
    // The window only ever shows the bundled page.
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    // The right pane's browser frame stays on the annex; links elsewhere go nowhere.
    created.webContents.on("will-frame-navigate", (event) => {
        if (event.isMainFrame) return;
        if (!onAnnex(event.url)) event.preventDefault();
    });
    // A shortcut handled here never reaches the page or the menu, so it runs once.
    created.webContents.on("before-input-event", (event, input) => {
        const command = shortcutCommand(input, process.platform);
        if (command === undefined) return;
        event.preventDefault();
        sendEvent({ type: "command", id: command });
    });
    created.on("close", shutdown);
    created.on("closed", () => {
        if (window === created) window = undefined;
    });
    void created.loadFile(join(import.meta.dirname, "renderer", "index.html"));
    return created;
}

ipcMain.on(CHANNELS.start, (event) => {
    if (fromWindow(event)) startBoot();
});
ipcMain.on(CHANNELS.reconnect, (event) => {
    if (fromWindow(event)) startBoot();
});
ipcMain.on(CHANNELS.answer, (event, payload: unknown) => {
    if (!fromWindow(event) || typeof payload !== "object" || payload === null) return;
    const answer = payload as { id?: unknown; yes?: unknown };
    if (typeof answer.id !== "string" || typeof answer.yes !== "boolean") return;
    boot?.answer(answer.id, answer.yes);
});
ipcMain.on(CHANNELS.send, (event, text: unknown) => {
    if (!fromWindow(event) || typeof text !== "string" || text.length > MAX_SEND_BYTES) return;
    pipe.send(text);
});
ipcMain.on(CHANNELS.sessionWatch, (event, pane: unknown, agentId: unknown) => {
    const target = sessionPanes.get(pane);
    if (!fromWindow(event) || target === undefined) return;
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS) return;
    target.watch(agentId);
});
ipcMain.on(CHANNELS.sessionSend, (event, pane: unknown, text: unknown) => {
    const target = sessionPanes.get(pane);
    if (!fromWindow(event) || target === undefined || typeof text !== "string" || text.length > MAX_SEND_BYTES) return;
    target.send(text);
});
ipcMain.on(CHANNELS.sessionUnwatch, (event, pane: unknown) => {
    if (fromWindow(event)) sessionPanes.get(pane)?.unwatch();
});
ipcMain.handle(CHANNELS.sessionBranch, async (event, agentId: unknown, boundaryId: unknown): Promise<BranchSessionResult> => {
    const source = idArgument(agentId);
    const boundary = idArgument(boundaryId);
    if (!fromWindow(event) || source === undefined || boundary === undefined) return { ok: false, reason: "Choose a prompt to fork from." };
    return branchSession(hostSocketPath, source, boundary);
});
ipcMain.handle(CHANNELS.sessionClone, async (event, agentId: unknown): Promise<BranchSessionResult> => {
    const source = idArgument(agentId);
    if (!fromWindow(event) || source === undefined) return { ok: false, reason: "Open a session to clone." };
    return cloneSession(hostSocketPath, source);
});
ipcMain.handle(CHANNELS.sidekickOpen, async (event, agentId: unknown): Promise<OpenSidekickResult> => {
    const primary = idArgument(agentId);
    if (!fromWindow(event) || primary === undefined) return { ok: false, reason: "Open a session first." };
    return openSidekick(hostSocketPath, primary);
});
ipcMain.handle(CHANNELS.sidekickSync, async (event, agentId: unknown): Promise<SyncSidekickResult> => {
    const target = idArgument(agentId);
    if (!fromWindow(event) || target === undefined) return { ok: false, reason: "Choose a side chat." };
    return syncSidekick(hostSocketPath, target);
});
ipcMain.handle(CHANNELS.sessionClose, async (event, agentId: unknown): Promise<CloseSessionResult> => {
    const target = idArgument(agentId);
    if (!fromWindow(event) || target === undefined) return { ok: false, reason: "Choose a session to stop." };
    return closeSession(hostSocketPath, target);
});
ipcMain.handle(CHANNELS.sessionArchive, async (event, agentId: unknown, archived: unknown) => {
    const target = idArgument(agentId);
    if (!fromWindow(event) || target === undefined || typeof archived !== "boolean" || hostSocketPath === undefined) {
        return { ok: false, reason: "The host is not running." };
    }
    try {
        return await setSessionArchivedThroughHost(hostSocketPath, target, archived)
            ? { ok: true } : { ok: false, reason: "The session could not be updated." };
    } catch {
        return { ok: false, reason: "The session could not be updated." };
    }
});
ipcMain.handle(CHANNELS.sessionMove, async (event, agentId: unknown): Promise<MoveSessionOutcome> => {
    const target = idArgument(agentId);
    const parent = window;
    if (!fromWindow(event) || parent === undefined) return { status: "rejected", reason: "failed" };
    if (target === undefined) return { status: "rejected", reason: "not_found" };
    return moveSessionToFolder({
        socketPath: hostSocketPath,
        sessionId: target,
        chooseFolder: () => chooseFolder(parent),
        move: moveSessionThroughHost,
    });
});
ipcMain.handle(CHANNELS.layoutLoad, (event) => (fromWindow(event) ? layoutStore.load() ?? null : null));
ipcMain.on(CHANNELS.layoutSave, (event, layout: unknown) => {
    if (fromWindow(event)) layoutStore.save(layout);
});
ipcMain.handle(CHANNELS.pinsLoad, (event) => (fromWindow(event) ? pinStore.load() ?? NO_PINS : NO_PINS));
ipcMain.on(CHANNELS.pinsSave, (event, pins: unknown) => {
    if (fromWindow(event)) pinStore.save(pins);
});
ipcMain.handle(CHANNELS.feedbackCapture, async (event): Promise<string | undefined> => {
    if (!fromWindow(event) || window === undefined) return undefined;
    try {
        const image = await window.webContents.capturePage();
        const png = image.toPNG();
        return png.length <= 10 * 1024 * 1024 ? image.toDataURL() : undefined;
    } catch { return undefined; }
});
ipcMain.handle(CHANNELS.feedbackSave, async (event, request: unknown) => {
    if (!fromWindow(event) || hostSocketPath === undefined) return { ok: false, reason: "The host is not running. Restart Vera and try again." };
    if (request === null || typeof request !== "object" || Array.isArray(request)) return { ok: false, reason: "Invalid report." };
    const value = request as Record<string, unknown>;
    if ((value.kind !== "bug" && value.kind !== "feature") || typeof value.title !== "string" || typeof value.description !== "string" || !Array.isArray(value.image_paths) || value.image_paths.some((path) => typeof path !== "string") || (value.session_id !== undefined && typeof value.session_id !== "string")) return { ok: false, reason: "Invalid report." };
    try {
        const result = await requestExtensionThroughHost(hostSocketPath, "vera.feedback", "save", {
            kind: value.kind, title: value.title, description: value.description, source: "window", image_paths: value.image_paths as string[],
            ...(typeof value.session_id === "string" ? { session_id: value.session_id } : {}),
        }, AbortSignal.timeout(30000));
        const record = result as { readonly path?: unknown } | null;
        if (record === null || typeof record !== "object" || typeof record.path !== "string") throw new Error("Restart Vera and try again.");
        return { ok: true, path: record.path };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save the report.";
        return { ok: false, reason: /extension|host did not answer|host connection closed|unsupported|protocol|timeout/i.test(message) ? "Restart Vera and try again." : message };
    }
});
ipcMain.handle(CHANNELS.flagsLoad, (event) => (fromWindow(event) ? flagsStore.read() : DEFAULT_DESKTOP_FLAGS));
ipcMain.handle(CHANNELS.flagsSave, (event, patch: unknown) => {
    if (!fromWindow(event)) return null;
    const hidden = hidesReasoning();
    const saved = flagsStore.update(patch);
    if (saved === undefined) return null;
    if (hidesReasoning() !== hidden) sessionPanes.reattach();
    return saved;
});
ipcMain.on(CHANNELS.flagsHidden, (event, ids: unknown) => {
    const next = fromWindow(event) ? parseHiddenIds(ids) : undefined;
    if (next === undefined || (next.size === hiddenCommands.size && [...next].every((id) => hiddenCommands.has(id)))) return;
    hiddenCommands = next;
    installMenu();
});
ipcMain.on(CHANNELS.titleBar, (event, height: unknown) => {
    if (!fromWindow(event) || process.platform !== "darwin") return;
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    const clamped = Math.min(Math.max(height, TITLE_BAR_HEIGHT_RANGE.min), TITLE_BAR_HEIGHT_RANGE.max);
    window?.setWindowButtonPosition(trafficLightPosition(clamped));
});
ipcMain.on(CHANNELS.theme, (event, choice: unknown) => {
    if (!fromWindow(event) || typeof choice !== "string" || !isThemeChoice(choice) || choice === activeTheme) return;
    const slug = importedThemeSlug(choice);
    if (slug !== undefined && !themeService.has(slug)) return;
    activeTheme = choice;
    installMenu();
});
ipcMain.handle(CHANNELS.themesLoad, (event) => (fromWindow(event) ? themeService.load() : []));
ipcMain.handle(CHANNELS.extensionCommand, async (event, command: unknown, pick: unknown): Promise<ExtensionCommandResult> => {
    if (!fromWindow(event) || window === undefined) return { ok: false, reason: "That window cannot import themes." };
    if (typeof command !== "string" || (pick !== undefined && typeof pick !== "string")) return { ok: false, reason: "Vera could not import that theme." };
    const script = extensionStore.pageScript(command);
    if (script !== undefined && pick === undefined) {
        const native = browserPane?.current();
        const contents = native ?? window.webContents;
        const frame = native === undefined ? await browserFrame(contents, onAnnex) : undefined;
        if (native === undefined && frame === undefined) return { ok: true, kind: "closed" };
        return pageCommands.run(script, contents, pastedImageDirectory(selectedVeraHome()), frame);
    }
    return extensionCommands.run(command, pick);
});
registerExtensionHandlers({ service: extensionService, catalog: extensionCatalog, window: () => window, fromWindow });
// A mode name the host can look up; anything else starts the session with the host default.
const APPROVAL_MODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

ipcMain.handle(
    CHANNELS.sessionCreate,
    async (event, workspace: unknown, approvalMode: unknown, notesOffer: unknown): Promise<CreateSessionResult> => {
        if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
        if (hostSocketPath === undefined) return { ok: false, reason: "The host is not running." };
        // No folder asks for a chat; a folder that is given must be an absolute path.
        let folder: string | undefined;
        if (workspace !== undefined && workspace !== null) {
            if (typeof workspace !== "string" || !isAbsolute(workspace)) return { ok: false, reason: "Choose a folder first." };
            folder = workspace;
        }
        const mode = typeof approvalMode === "string" && APPROVAL_MODE_PATTERN.test(approvalMode) ? approvalMode : undefined;
        try {
            const ready = await createAgentThroughHost(hostSocketPath, folder, mode, undefined, "default", notesOffer === true);
            return { ok: true, agentId: ready.id, workspace: ready.workspace };
        } catch (error) {
            if (error instanceof AgentStartError && error.reason !== undefined) {
                return { ok: false, reason: error.reason };
            }
            return { ok: false, reason: folder === undefined ? "Vera could not start a chat." : "Vera could not start a session in that folder." };
        }
    },
);
ipcMain.handle(CHANNELS.foldersExisting, async (event, folders: unknown): Promise<readonly string[]> =>
    fromWindow(event) ? existingFolders(folderListArgument(folders)) : []);
ipcMain.handle(CHANNELS.folderChoose, async (event): Promise<string | undefined> => {
    if (!fromWindow(event) || window === undefined) return undefined;
    return chooseFolder(window);
});
ipcMain.handle(CHANNELS.imagesChoose, async (event): Promise<readonly string[]> => {
    if (!fromWindow(event) || window === undefined) return [];
    const result = await dialog.showOpenDialog(window, {
        properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
});
ipcMain.handle(CHANNELS.filesCheck, async (event, path: unknown, workspace: unknown, chat: unknown): Promise<{ kind?: "file" | "folder"; error?: string }> => {
    if (!fromWindow(event) || typeof path !== "string" || !isAbsolute(path) || typeof chat !== "boolean") return { error: "Could not attach this file." };
    try {
        return { kind: await checkFile(path, { workspace: typeof workspace === "string" && isAbsolute(workspace) ? workspace : "/", chat }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return { error: message.startsWith("Folders cannot") || message.startsWith("Files must") || message.startsWith("That is not")
            ? message : "Could not attach this file." };
    }
});
ipcMain.handle(CHANNELS.filesPrepare, async (event, paths: unknown, workspace: unknown, chat: unknown) => {
    if (!fromWindow(event) || !Array.isArray(paths) || paths.length > FILE_COUNT_LIMIT
        || !paths.every((path) => typeof path === "string" && isAbsolute(path))
        || typeof workspace !== "string" || !isAbsolute(workspace) || typeof chat !== "boolean") return { error: "Could not attach these files." };
    try {
        return { paths: await prepareFiles(paths, { workspace, chat }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return { error: message.startsWith("Folders cannot") || message.startsWith("Files must") ? message : "Could not attach these files." };
    }
});
ipcMain.handle(CHANNELS.imagePaste, async (event, data: unknown, mediaType: unknown): Promise<string | undefined> => {
    if (!fromWindow(event) || !(data instanceof Uint8Array) || typeof mediaType !== "string") return undefined;
    return savePastedImage(pastedImageDirectory(selectedVeraHome()), data, mediaType).catch(() => undefined);
});
ipcMain.handle(CHANNELS.branchRead, async (event, folder: unknown): Promise<string | undefined> => {
    if (!fromWindow(event) || typeof folder !== "string" || !isAbsolute(folder)) return undefined;
    return readBranch(folder);
});
ipcMain.handle(CHANNELS.folderList, async (event, folder: unknown): Promise<FolderListing> => {
    const path = pathArgument(folder);
    if (!fromWindow(event) || path === undefined) return { ok: false, reason: "That is not a folder path." };
    return listFolder(path);
});
ipcMain.handle(CHANNELS.fileRead, async (event, file: unknown): Promise<FilePreview> => {
    const path = pathArgument(file);
    if (!fromWindow(event) || path === undefined) return { ok: false, reason: "That is not a file path." };
    return readFilePreview(path);
});
ipcMain.handle(CHANNELS.modelsRead, (event, workspace: unknown) =>
    fromWindow(event) ? readModels(hostSocketPath, workspaceArgument(workspace)) : undefined);
ipcMain.handle(CHANNELS.catalogRefresh, (event, provider: unknown, workspace: unknown) => {
    const id = providerArgument(provider);
    if (!fromWindow(event) || id === undefined) return { ok: false, reason: "That is not a provider Vera knows." };
    return refreshProvider(hostSocketPath, id, workspaceArgument(workspace));
});
let providerLogin: AbortController | undefined;
ipcMain.handle(CHANNELS.providerList, async (event) => {
    if (!fromWindow(event) || hostSocketPath === undefined) return { ok: false, reason: "The host is not running." };
    try { return { ok: true, ...await listProvidersThroughHost(hostSocketPath) }; }
    catch { return { ok: false, reason: "The host did not list providers." }; }
});
ipcMain.handle(CHANNELS.providerSave, async (event, value: unknown) => {
    if (!fromWindow(event) || hostSocketPath === undefined || typeof value !== "object" || value === null) return { ok: false, reason: "Could not save provider." };
    const input = value as Record<string, unknown>;
    const provider = providerArgument(input.provider);
    if (provider === undefined || typeof input.key !== "string" || typeof input.endpoint !== "string"
        || (input.protocol !== "openai-chat" && input.protocol !== "anthropic-messages") || typeof input.custom !== "boolean") return { ok: false, reason: "Could not save provider." };
    try {
        const result = await saveProviderThroughHost(hostSocketPath, { id: provider, apiKey: input.key, custom: input.custom,
            declaration: { protocol: input.protocol, credential: "api_key", base_url: input.endpoint },
            ...(typeof input.editing === "string" && providerArgument(input.editing) === input.editing ? { editing: input.editing } : {}) });
        return { ok: true, provider: result };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Could not save provider.";
        return { ok: false, reason: input.key ? reason.split(input.key).join("[redacted]") : reason };
    }
});
ipcMain.handle(CHANNELS.providerSelectModel, async (event, provider: unknown, model: unknown) => {
    const id = providerArgument(provider);
    const name = modelArgument(model);
    if (!fromWindow(event) || hostSocketPath === undefined || id === undefined || name === undefined) return { ok: false, reason: "That model is unavailable." };
    try { await selectProviderModelThroughHost(hostSocketPath, id, name); return { ok: true }; }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "The model did not answer." }; }
});
ipcMain.handle(CHANNELS.providerSignIn, async (event, value: unknown) => {
    const provider = providerArgument(value);
    if (!fromWindow(event) || hostSocketPath === undefined || provider === undefined) return { ok: false, reason: "Could not start sign-in." };
    providerLogin?.abort();
    const controller = new AbortController();
    providerLogin = controller;
    try {
        const result = await loginProviderThroughHost(hostSocketPath, provider, (url) => {
            try {
                const parsed = new URL(url);
                if (parsed.protocol === "http:" || parsed.protocol === "https:") void shell.openExternal(url).catch(() => controller.abort());
            } catch { controller.abort(); }
        }, controller.signal);
        return { ok: true, provider: result };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Sign-in failed." }; }
    finally { if (providerLogin === controller) providerLogin = undefined; }
});
ipcMain.on(CHANNELS.providerSignInCancel, (event) => { if (fromWindow(event)) providerLogin?.abort(); });
ipcMain.handle(CHANNELS.providerForget, (event, provider: unknown, workspace: unknown) => {
    const id = providerArgument(provider);
    if (!fromWindow(event) || id === undefined) return { ok: false, reason: "That is not a provider Vera knows." };
    return forgetProvider(hostSocketPath, id, workspaceArgument(workspace));
});
ipcMain.handle(CHANNELS.modelOperate, (event, operation: unknown, provider: unknown, model: unknown, workspace: unknown) => {
    const kind = operationArgument(operation);
    const id = providerArgument(provider);
    const name = modelArgument(model);
    if (!fromWindow(event) || kind === undefined || id === undefined || name === undefined) {
        return { ok: false, reason: "That is not a model Vera knows." };
    }
    return operateModel(hostSocketPath, kind, id, name, workspaceArgument(workspace));
});
ipcMain.handle(CHANNELS.assignmentsRead, (event) =>
    fromWindow(event) ? assignments.read() : { ok: false, reason: "That window cannot read assignments." });
ipcMain.handle(CHANNELS.includedExtensionsRead, (event) =>
    fromWindow(event) ? assignments.readIncludedExtensions() : { ok: false, reason: "That window cannot read extensions." });
ipcMain.handle(CHANNELS.assignmentsEdit, (event, change: unknown) => {
    const edit = changeArgument(change);
    if (!fromWindow(event) || edit === undefined) return { ok: false, reason: "That is not an assignment change." };
    return assignments.edit(edit);
});
ipcMain.handle(CHANNELS.assignmentsAll, (event, provider: unknown, model: unknown) => {
    const id = providerArgument(provider);
    const name = modelArgument(model);
    if (!fromWindow(event) || id === undefined || name === undefined) return { ok: false, reason: "That is not a model Vera knows." };
    return assignments.assignAll(id, name);
});
ipcMain.handle(CHANNELS.sessionsSearch, (event, request: unknown) => {
    const parsed = searchArgument(request);
    if (!fromWindow(event) || parsed === undefined) return { ok: false, reason: "That search could not be sent." };
    return searchSessions(hostSocketPath, parsed);
});
ipcMain.handle(CHANNELS.folderReveal, async (event, folder: unknown): Promise<boolean> => {
    if (!fromWindow(event) || typeof folder !== "string" || !isAbsolute(folder)) return false;
    return (await shell.openPath(folder)) === "";
});
ipcMain.handle(CHANNELS.extensionFailures, (event) =>
    fromWindow(event) ? readExtensionFailures(hostSocketPath) : { ok: false, reason: "The host is not running." });
ipcMain.handle(CHANNELS.newSessionAgents, (event, workspace: unknown) => {
    if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
    if (workspace !== undefined && workspaceArgument(workspace) === undefined) return { ok: false, reason: "That is not a folder." };
    return readNewSessionAgents(hostSocketPath, workspace);
});
ipcMain.handle(CHANNELS.folderCustomizations, (event, workspace: unknown) => {
    if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
    if (workspace !== undefined && workspaceArgument(workspace) === undefined) return { ok: false, reason: "That is not a folder." };
    return readFolderCustomizations(hostSocketPath, workspace);
});
ipcMain.handle(CHANNELS.annexPages, async (event) => {
    if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
    const result = await readAnnexPages(hostSocketPath);
    if (result.ok) annexUrl = result.url;
    return result;
});
ipcMain.handle(CHANNELS.annexOpen, async (event, path: unknown): Promise<boolean> => {
    const address = annexUrl === undefined ? undefined : annexAddress(annexUrl, path);
    if (!fromWindow(event) || address === undefined) return false;
    await shell.openExternal(address);
    return true;
});
ipcMain.handle(CHANNELS.browser, async (event, command: unknown, value: unknown) => {
    if (!fromWindow(event) || browserPane === undefined) return { tabs: [], active: null, toolsEnabled: false, toolsAvailable: false };
    const pane = browserPane;
    if (command !== "state" && command !== "bounds" && browserClearing !== undefined) await browserClearing;
    let opened: number | undefined;
    if (command === "open" && (value === undefined || typeof value === "string")) opened = pane.open(value);
    if (command === "navigate" && typeof value === "string") {
        if (pane.current() === undefined) pane.open(value);
        else await pane.navigate(value).catch(() => {});
    }
    if (command === "select" && (value === null || typeof value === "number")) {
        if (pane.state().active !== value) pageCommands.stop();
        pane.select(value);
    }
    if (command === "close" && typeof value === "number") pane.close(value);
    if (command === "back" && pane.current()?.navigationHistory.canGoBack()) pane.current()?.navigationHistory.goBack();
    if (command === "forward" && pane.current()?.navigationHistory.canGoForward()) pane.current()?.navigationHistory.goForward();
    if (command === "reload") pane.current()?.reload();
    if (command === "external") {
        const url = pane.current()?.getURL();
        if (url !== undefined && /^https?:\/\//.test(url)) await shell.openExternal(url);
    }
    if (command === "forget") {
        const clearing = browserGateway?.forget() ?? Promise.reject(new Error("The host is not running."));
        browserClearing = clearing;
        try { await clearing; } finally { if (browserClearing === clearing) browserClearing = undefined; }
    }
    if (command === "tools" && typeof value === "boolean") await browserGateway?.settings(value);
    if (command === "bounds") {
        const rect = value as Record<string, unknown> | null;
        if (rect === null || typeof rect !== "object") pane.layout(undefined);
        else if ([rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 10000)) {
            pane.layout({ x: Math.round(rect.x as number), y: Math.round(rect.y as number), width: Math.round(rect.width as number), height: Math.round(rect.height as number) });
        }
    }
    return {
        ...pane.state(),
        toolsEnabled: browserGateway?.enabled ?? false,
        toolsAvailable: browserGateway?.available ?? false,
        ...(opened === undefined ? {} : { opened }),
    };
});
ipcMain.on(CHANNELS.windowBackground, (event, value: unknown) => {
    if (!fromWindow(event)) return;
    const color = parseWindowBackground(value);
    if (color !== undefined) window?.setBackgroundColor(color);
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => app.quit());
app.whenReady().then(() => {
    startExtensions();
    themeService.load();
    installMenu();
    window = createWindow();
    browserPane = new BrowserPane(window);
    browserGateway = new BrowserGateway(new BrowserCdp(browserPane), () => sendEvent({ type: "command", id: "browser.reveal" }));
});
