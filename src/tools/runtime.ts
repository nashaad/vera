import { randomUUID } from "node:crypto";

import {
    ManagedProcessRegistry,
    type ManagedProcessScope,
    type SandboxCommandIdentity,
} from "./process-runtime.ts";
import type { CommandSandbox } from "../sandbox/types.ts";

export type PreimageRecorder = (
    path: string,
    content: string,
) => Promise<void>;

export interface SkillFileCheck {
    readonly projectRoot: string;
    readonly path: string;
    readonly allowedSkills?: readonly string[];
    readonly isSubagent: boolean;
    readonly userInvokedSkill?: string;
}

// Returns the refusal for reading a SKILL.md, or undefined to allow it.
export type CheckSkillFile = (
    check: SkillFileCheck,
) => Promise<string | undefined>;

export class ToolRuntime {
    readonly workspace: string;
    readonly instructionRoot: string;
    readonly stashDirectory: string | undefined;
    readonly scratchDirectory: string | undefined;
    readonly env: Readonly<Record<string, string>> | undefined;
    readonly processes: ManagedProcessScope;
    readonly sandbox: CommandSandbox | undefined;
    allowedSkills: readonly string[] | undefined;
    userInvokedSkill: string | undefined;
    readonly isSubagent: boolean;
    readonly invocation: "top_level" | "subagent";
    allowedTools: readonly string[] | undefined;
    // The selected agent's name, set by the turn. A tool limited to named agents never runs while this is unset.
    agentName: string | undefined;
    sessionId: string | undefined;
    // Set by the executor for a tool that cannot run in parallel, so the
    // command it starts can be logged with the call that started it.
    currentToolCallId: string | undefined;
    // The session's live approval mode, which decides the full_access exemption.
    readApprovalMode: (() => string | undefined) | undefined;
    // The session's read roots; a sandbox that fences reads leaves them readable.
    readRoots: readonly string[] | undefined;
    // Set by a host that owns skill settings; unset, the read tool checks locally.
    checkSkillFile: CheckSkillFile | undefined;
    private readonly fileSnapshots = new Map<string, string>();
    private readonly preimageRecorder: PreimageRecorder | undefined;
    private readonly ownedProcessRegistry: ManagedProcessRegistry | undefined;
    private mutationTail: Promise<void> = Promise.resolve();

    constructor(
        workspace: string,
        preimageRecorder?: PreimageRecorder,
        stashDirectory?: string,
        env?: Readonly<Record<string, string>>,
        instructionRoot?: string,
        processes?: ManagedProcessScope,
        isSubagent = false,
        scratchDirectory?: string,
    ) {
        this.isSubagent = isSubagent;
        this.scratchDirectory = scratchDirectory;
        this.invocation = isSubagent ? "subagent" : "top_level";
        this.workspace = workspace;
        this.instructionRoot = instructionRoot ?? workspace;
        this.preimageRecorder = preimageRecorder;
        this.stashDirectory = stashDirectory;
        this.env = env;
        if (processes === undefined) {
            const registry = new ManagedProcessRegistry();
            this.ownedProcessRegistry = registry;
            this.processes = registry.scope(`standalone-${randomUUID()}`);
            this.sandbox = registry.commandSandbox;
        } else {
            this.ownedProcessRegistry = undefined;
            this.processes = processes;
            this.sandbox = processes.sandbox;
        }
        this.allowedSkills = undefined;
        this.userInvokedSkill = undefined;
        this.allowedTools = undefined;
        this.agentName = undefined;
        this.sessionId = undefined;
        this.currentToolCallId = undefined;
        this.readApprovalMode = undefined;
        this.readRoots = undefined;
        this.checkSkillFile = undefined;
    }

    // What a sandboxed command needs to identify itself in the host log.
    sandboxIdentity(): SandboxCommandIdentity | undefined {
        if (this.sessionId === undefined) return undefined;
        const mode = this.readApprovalMode?.();
        return {
            sessionId: this.sessionId,
            ...(this.scratchDirectory === undefined
                ? {}
                : { scratchDir: this.scratchDirectory }),
            ...(this.readRoots === undefined
                ? {}
                : { readRoots: this.readRoots }),
            ...(this.currentToolCallId === undefined
                ? {}
                : { toolCallId: this.currentToolCallId }),
            ...(mode === undefined ? {} : { approvalMode: mode }),
        };
    }

    recordFileSnapshot(path: string, content: string): void {
        this.fileSnapshots.set(path, content);
    }

    async stashPreimage(path: string, content: string): Promise<void> {
        if (this.preimageRecorder === undefined) {
            return;
        }
        try {
            await this.preimageRecorder(path, content);
        } catch {
            // A failed capture must not fail the write.
        }
    }

    assertFreshFileSnapshot(
        path: string,
        content: string,
        requestedPath: string,
    ): void {
        const snapshot = this.fileSnapshots.get(path);
        if (snapshot === undefined) {
            throw new Error(
                `Read ${requestedPath} with the read tool through its last line before editing it.`,
            );
        }
        if (snapshot !== content) {
            throw new Error(`File changed since it was read: ${requestedPath}`);
        }
    }

    enqueueFileMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationTail.then(operation);
        this.mutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    async close(): Promise<void> {
        if (this.ownedProcessRegistry !== undefined) {
            await this.ownedProcessRegistry.close();
            return;
        }
        await this.processes.close();
    }
}
