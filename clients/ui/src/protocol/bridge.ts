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
