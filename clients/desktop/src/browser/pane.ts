import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, session, WebContentsView, type BrowserWindow } from "electron";

import { BROWSER_TAB_LIMIT, type BrowserBounds, type BrowserState } from "../../../ui/src/browser/native-types.ts";

const URL_LIMIT = 8192;

export function browserUrl(value: string): string | undefined {
    if (value.length > URL_LIMIT) return undefined;
    const text = value.trim();
    if (text === "") return undefined;
    try {
        if (/^[a-z][a-z0-9+.-]*:(?!\/\/|[0-9])/i.test(text)) return undefined;
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function isWebUrl(value: string): boolean {
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

export class BrowserPane {
    private readonly tabs = new Map<number, WebContentsView>();
    private active: number | null = null;
    private nextId = 1;
    private bounds: BrowserBounds | undefined;
    private clearing = false;
    private browsingSession: Electron.Session | undefined;

    constructor(private readonly window: BrowserWindow, private readonly home: string) {}

    private session(): Electron.Session {
        if (this.browsingSession !== undefined) return this.browsingSession;
        const directory = join(this.home, "machine", "desktop", "browser");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        process.umask(0o077);
        const browserSession = session.fromPath(directory);
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

    open(value?: string): number | undefined {
        if (this.clearing || this.tabs.size >= BROWSER_TAB_LIMIT) return undefined;
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
        if (this.clearing) throw new Error("Browsing data is being cleared.");
        const url = browserUrl(value);
        const contents = this.current();
        if (url === undefined || contents === undefined) throw new Error("That address cannot be opened.");
        await contents.loadURL(url);
    }

    async forget(): Promise<void> {
        this.clearing = true;
        try {
            this.select(null);
            for (const id of [...this.tabs.keys()]) this.close(id);
            await this.session().clearData();
            await this.session().clearAuthCache();
        } finally { this.clearing = false; }
    }

    dispose(): void {
        this.select(null);
        for (const id of [...this.tabs.keys()]) this.close(id);
    }
}
