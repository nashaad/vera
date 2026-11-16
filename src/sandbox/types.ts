import type { SandboxInspection } from "../sdk/sandbox.ts";

export type SandboxViolationKind = "read" | "write" | "connect" | "other";

export interface SandboxViolation {
    readonly kind: SandboxViolationKind;
    readonly target: string;
    /** srt's line, cut to 300 characters for the host log. */
    readonly line: string;
}

export interface SandboxCommandRequest {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    /** The session's mode; `full_access` runs the command unwrapped. */
    readonly approvalMode?: string;
}

export interface SandboxPreparedCommand {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly commandId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly command: string;
    /** Violation lines the process's store held when the command started. */
    readonly violationsBefore: number;
}

/** A command that ran without the sandbox and is logged when it ends. */
export interface SandboxUnwrappedCommand {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly commandId: string;
    readonly reason: "unavailable" | "full_access";
}

export interface SandboxPreparation {
    /** The command to spawn instead of the original one. */
    readonly prepared?: SandboxPreparedCommand;
    /** A command that ran unwrapped and must be logged when it ends. */
    readonly unwrapped?: SandboxUnwrappedCommand;
    /** A sentence to add to the tool result, for the unavailable warning. */
    readonly notice?: string;
    /** The command must not run. */
    readonly refusal?: string;
}

export interface SandboxSettledCommand {
    /** Text to append to the command output, empty when nothing was blocked. */
    readonly suffix: string;
    readonly violations: readonly SandboxViolation[];
}

export interface CommandSandbox {
    prepare(request: SandboxCommandRequest): Promise<SandboxPreparation>;
    settle(
        prepared: SandboxPreparedCommand,
        exitCode: number | null,
    ): Promise<SandboxSettledCommand>;
    settleSync(prepared: SandboxPreparedCommand): SandboxSettledCommand;
    /** Logs a command that ran unwrapped once it has ended. */
    finishUnwrapped(unwrapped: SandboxUnwrappedCommand, exitCode: number | null): void;
    /** Called when a prepared command will never be settled. */
    release(prepared: SandboxPreparedCommand): void;
    /**
     * The command's child has exited, or its wrap will never be spawned.
     * Runs srt's per-command cleanup once per wrap; a second call is ignored.
     */
    commandEnded(prepared: SandboxPreparedCommand): void;
    /**
     * A turn ended. A sandbox that recovers missed denials schedules the read
     * and returns at once, so the turn is never delayed.
     */
    turnEnded?(): void;
}

/** What `/permissions` asks the process's sandbox for. */
export interface SandboxInspector {
    inspection(): SandboxInspection;
}

export const NO_SANDBOX_PREPARATION: SandboxPreparation = Object.freeze({});
