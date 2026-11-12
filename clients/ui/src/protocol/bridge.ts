import type { LayoutState } from "../layout/model.ts";
import type { ThemeName } from "../theme/tokens.ts";

export type DesktopPhase = "starting" | "waiting" | "attached";

export type DesktopEvent =
    | { readonly type: "phase"; readonly phase: DesktopPhase }
    | {
        readonly type: "ready";
        readonly pid: number;
        readonly socketPath: string;
        readonly buildId: string | null;
        readonly home: string;
    }
    | { readonly type: "question"; readonly id: string; readonly text: string }
    | { readonly type: "frame"; readonly text: string }
    // One line from the watch connection of the session being viewed.
    | { readonly type: "session_frame"; readonly agentId: string; readonly text: string }
    | { readonly type: "session_closed"; readonly agentId: string; readonly reason: string }
    | { readonly type: "disconnected"; readonly reason: string }
    | { readonly type: "failed"; readonly message: string }
    // A native menu item or shortcut asking the page to run one of its commands.
    | { readonly type: "command"; readonly id: string }
    | {
        readonly type: "missing_cli";
        readonly message: string;
        readonly checked: readonly string[];
    };

export interface CreatedSession {
    readonly ok: true;
    readonly agentId: string;
    readonly workspace: string;
}

export interface CreateSessionFailure {
    readonly ok: false;
    // Phrased for the person; never raw error text.
    readonly reason: string;
}

export type CreateSessionResult = CreatedSession | CreateSessionFailure;

export interface DesktopBridge {
    readonly platform: string;
    start(): void;
    reconnect(): void;
    answer(id: string, yes: boolean): void;
    send(text: string): void;
    // Opens the one watch connection for a session, closing any earlier one.
    watchSession(agentId: string): void;
    // Sends one request line on the watch connection, such as a history page request.
    sendSession(text: string): void;
    unwatchSession(): void;
    // Asks the attached host to create a session in an absolute folder.
    createSession(workspace: string): Promise<CreateSessionResult>;
    // Opens the native folder picker; undefined when cancelled.
    chooseFolder(): Promise<string | undefined>;
    // Opens the native picker for image files; empty when cancelled.
    chooseImages(): Promise<readonly string[]>;
    // The file's path on disk, or undefined for data with no file behind it, such as a pasted bitmap.
    pathForFile(file: File): string | undefined;
    // Writes pasted image bytes to a file the host can read; undefined when the type or size is refused.
    savePastedImage(data: Uint8Array, mediaType: string): Promise<string | undefined>;
    // The checked-out branch of a folder's git repository, or undefined when none.
    readBranch(folder: string): Promise<string | undefined>;
    // Tells the shell how tall the drawn title bar is so native window controls can center in it.
    setTitleBarHeight(height: number): void;
    // Tells the shell the page surface color so the native window matches it while it resizes.
    setWindowBackground(color: string): void;
    // Tells the shell which theme is active so the View menu can check it.
    setTheme(name: ThemeName): void;
    // The saved layout, or undefined when none is saved or the file was unreadable.
    loadLayout(): Promise<LayoutState | undefined>;
    saveLayout(layout: LayoutState): void;
    onEvent(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
    interface Window {
        readonly veraDesktop: DesktopBridge;
    }
}
