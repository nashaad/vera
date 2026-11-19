import { join } from "node:path";
import { app, session, WebContentsView, type BrowserWindow } from "electron";

import { BROWSER_TAB_LIMIT, type BrowserBounds, type BrowserState } from "../../../ui/src/browser/native-types.ts";
import { browserUrl, URL_LIMIT } from "../../../ui/src/browser/url.ts";
import { BROWSER_HISTORY_COMMAND } from "../../../ui/src/commands/keys.ts";
import { shortcutCommand } from "../shortcuts.ts";
import { BLOCKED_ANNEX_OPEN_ERROR, BrowserOriginGuard } from "./origin-guard.ts";

function isWebUrl(value: string): boolean {
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

export class BrowserPane {
    private readonly tabs = new Map<number, WebContentsView>();
    private active: number | null = null;
    private nextId = 1;
    private bounds: BrowserBounds | undefined;
    private browsingSession: Electron.Session | undefined;
    private readonly originGuard = new BrowserOriginGuard();

    constructor(
        private readonly window: BrowserWindow,
        private readonly loaded: (url: string, title: string) => void = () => {},
        private readonly shortcut: (command: "page.reload.native" | typeof BROWSER_HISTORY_COMMAND) => void = () => {},
    ) {}

    private session(): Electron.Session {
        if (this.browsingSession !== undefined) return this.browsingSession;
        const browserSession = session.fromPartition("vera-browser");
        browserSession.webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: this.originGuard.blocks(details.url) });
        });
        browserSession.setPermissionCheckHandler(() => false);
        browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        browserSession.on("will-download", (_event, item) => {
            item.setSaveDialogOptions({ defaultPath: join(app.getPath("downloads"), item.getFilename()) });
        });
        this.browsingSession = browserSession;
        return browserSession;
    }

    state(): Omit<BrowserState, "toolsEnabled" | "toolsAvailable"> {
        return {
            active: this.active,
            tabs: [...this.tabs].map(([id, view]) => ({
                id,
                title: view.webContents.getTitle().slice(0, 200) || "New tab",
                url: view.webContents.getURL().slice(0, URL_LIMIT),
                back: view.webContents.navigationHistory.canGoBack(),
                forward: view.webContents.navigationHistory.canGoForward(),
            })),
        };
    }

    setAnnexUrl(value: string | undefined): void {
        this.originGuard.setAnnexUrl(value);
    }

    open(value?: string): number | undefined {
        if (this.tabs.size >= BROWSER_TAB_LIMIT) return undefined;
        const url = value === undefined ? undefined : browserUrl(value);
        if (value !== undefined && url === undefined) return undefined;
        const { id, view } = this.createTab();
        if (url !== undefined) void view.webContents.loadURL(url).catch(() => {});
        return id;
    }

    private createTab(guest?: Electron.WebContents): { id: number; view: WebContentsView } {
        const view = guest === undefined
            ? new WebContentsView({ webPreferences: { session: this.session(), sandbox: true, contextIsolation: true, nodeIntegration: false } })
            : new WebContentsView({ webContents: guest });
        const id = this.nextId++;
        this.tabs.set(id, view);
        view.webContents.on("before-input-event", (event, input) => {
            const command = shortcutCommand(input, process.platform);
            if (command !== "page.reload" && command !== BROWSER_HISTORY_COMMAND) return;
            event.preventDefault();
            if (this.active === id && this.bounds !== undefined && this.bounds.width > 0 && this.bounds.height > 0) {
                this.shortcut(command === "page.reload" ? "page.reload.native" : command);
            }
        });
        const record = (): void => {
            const url = view.webContents.getURL();
            if (isWebUrl(url) && url.length <= URL_LIMIT && !this.originGuard.blocks(url)) this.loaded(url, (view.webContents.getTitle() || url).slice(0, 200));
        };
        view.webContents.on("did-finish-load", record);
        view.webContents.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) record(); });
        view.webContents.once("destroyed", () => {
            if (this.tabs.get(id) !== view) return;
            const wasActive = this.active === id;
            if (wasActive) {
                this.window.contentView.removeChildView(view);
                this.active = null;
            }
            this.tabs.delete(id);
            if (wasActive && this.tabs.size > 0) this.select(this.tabs.keys().next().value ?? null);
        });
        view.webContents.setWindowOpenHandler(({ url: target }) => {
            if (this.tabs.size >= BROWSER_TAB_LIMIT || (target !== "about:blank" && !isWebUrl(target))) return { action: "deny" };
            return {
                action: "allow", outlivesOpener: true,
                createWindow: (options) => {
                    const guestContents = (options as Electron.BrowserWindowConstructorOptions & { webContents?: Electron.WebContents }).webContents;
                    const child = this.createTab(guestContents).view.webContents;
                    if (guestContents === undefined && target !== "about:blank") void child.loadURL(target).catch(() => {});
                    return child;
                },
            };
        });
        view.webContents.on("will-navigate", (event, target) => {
            if (!isWebUrl(target)) event.preventDefault();
        });
        view.webContents.on("will-redirect", (event, target) => {
            if (!isWebUrl(target)) event.preventDefault();
        });
        this.select(id);
        return { id, view };
    }

    select(id: number | null): void {
        if (id !== null && !this.tabs.has(id)) return;
        if (this.active !== null) {
            const old = this.tabs.get(this.active);
            if (old !== undefined) this.window.contentView.removeChildView(old);
        }
        this.active = id;
        const view = id === null ? undefined : this.tabs.get(id);
        if (view !== undefined) {
            this.window.contentView.addChildView(view);
            this.layout(this.bounds);
        }
    }

    close(id: number): void {
        const view = this.tabs.get(id);
        if (view === undefined) return;
        const wasActive = this.active === id;
        if (wasActive) this.select(null);
        this.tabs.delete(id);
        view.webContents.close();
        if (wasActive && this.tabs.size > 0) this.select(this.tabs.keys().next().value ?? null);
    }

    layout(bounds: BrowserBounds | undefined): void {
        this.bounds = bounds;
        const view = this.active === null ? undefined : this.tabs.get(this.active);
        if (view === undefined) return;
        view.setVisible(bounds !== undefined && bounds.width > 0 && bounds.height > 0);
        if (bounds !== undefined) view.setBounds(bounds);
    }

    current(): Electron.WebContents | undefined {
        return this.active === null ? undefined : this.tabs.get(this.active)?.webContents;
    }

    async navigate(value: string): Promise<void> {
        const url = browserUrl(value);
        const contents = this.current();
        if (url === undefined || contents === undefined) throw new Error("That address cannot be opened.");
        if (this.originGuard.blocks(url)) throw new Error(BLOCKED_ANNEX_OPEN_ERROR);
        await contents.loadURL(url);
    }

    dispose(): void {
        this.select(null);
        for (const id of [...this.tabs.keys()]) this.close(id);
    }
}
