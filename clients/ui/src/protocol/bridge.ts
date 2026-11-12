import type { LayoutState } from "../layout/model.ts";
import type { ThemeName } from "../theme/tokens.ts";

export type DesktopPhase = "starting" | "waiting" | "attached";

// The session page shows one session and, beside it, at most one of its subagents.
export type SessionPane = "main" | "companion";

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
    // One line from the watch connection of a session being viewed.
    | { readonly type: "session_frame"; readonly pane: SessionPane; readonly agentId: string; readonly text: string }
    | { readonly type: "session_closed"; readonly pane: SessionPane; readonly agentId: string; readonly reason: string }
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

export interface HostRequestFailure {
    readonly ok: false;
    // Phrased for the person; never raw error text.
    readonly reason: string;
}

export interface HostModelsAnswer {
    readonly ok: true;
    // The host's `model_settings`; the page parses it.
    readonly settings: unknown;
}

export type HostModelsResult = HostModelsAnswer | HostRequestFailure;

export type ModelOperationKind = "keep" | "unkeep" | "verify";

export interface ModelCheck {
    readonly provider: string;
    readonly model: string;
    readonly status: "passed" | "failed";
    readonly reason?: string;
}

export interface ModelOperationAnswer {
    readonly ok: true;
    readonly results: readonly ModelCheck[];
    readonly settings?: unknown;
}

export type ModelOperationResult = ModelOperationAnswer | HostRequestFailure;

export interface BranchedSession {
    readonly ok: true;
    readonly agentId: string;
    readonly workspace: string;
    // The text of the prompt the fork stopped before, for the composer.
    readonly prompt: string;
}

export type BranchSessionResult = BranchedSession | HostRequestFailure;

export interface ClosedSession {
    readonly ok: true;
    // False when the host dropped the conversation rather than keeping it to resume.
    readonly retained: boolean;
}

export type CloseSessionResult = ClosedSession | HostRequestFailure;

export interface DesktopBridge {
    readonly platform: string;
    start(): void;
    reconnect(): void;
    answer(id: string, yes: boolean): void;
    send(text: string): void;
    // Opens the pane's watch connection for a session, closing any earlier one in that pane.
    watchSession(pane: SessionPane, agentId: string): void;
    // Sends one request line on the pane's watch connection, such as a history page request.
    sendSession(pane: SessionPane, text: string): void;
    unwatchSession(pane: SessionPane): void;
    // Starts a new session holding the conversation before one of the source session's prompts.
    branchSession(agentId: string, boundaryId: string): Promise<BranchSessionResult>;
    // Stops a session and parks it, as closing its last window would.
    closeSession(agentId: string): Promise<CloseSessionResult>;
    // Asks the attached host to create a session in an absolute folder, in the approval mode given or the host default.
    createSession(workspace: string, approvalMode?: string): Promise<CreateSessionResult>;
    // The host's models, shortlist and connected providers for a folder, or the host's own folder.
    readModelSettings(workspace?: string): Promise<HostModelsResult>;
    // Asks one provider for its model list again.
    refreshCatalog(provider: string, workspace?: string): Promise<HostModelsResult>;
    // Removes a provider's saved connection and what Vera learned about its models.
    forgetProvider(provider: string, workspace?: string): Promise<HostModelsResult>;
    // Adds a model to the shortlist, removes it, or probes it with a live request.
    operateModel(operation: ModelOperationKind, provider: string, model: string, workspace?: string): Promise<ModelOperationResult>;
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
