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
    | { readonly type: "disconnected"; readonly reason: string }
    | { readonly type: "failed"; readonly message: string }
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
    // Tells the shell how tall the drawn title bar is so native window controls can center in it.
    setTitleBarHeight(height: number): void;
    // Tells the shell the page surface color so the native window matches it while it resizes.
    setWindowBackground(color: string): void;
    onEvent(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
    interface Window {
        readonly veraDesktop: DesktopBridge;
    }
}
