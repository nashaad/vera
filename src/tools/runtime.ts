import { randomUUID } from "node:crypto";

import {
    ManagedProcessRegistry,
    type ManagedProcessScope,
} from "./process-runtime.ts";

export type PreimageRecorder = (
    path: string,
    content: string,
) => Promise<void>;

export class ToolRuntime {
    readonly workspace: string;
    readonly instructionRoot: string;
    readonly stashDirectory: string | undefined;
    readonly env: Readonly<Record<string, string>> | undefined;
    readonly processes: ManagedProcessScope;
    allowedSkills: readonly string[] | undefined;
    userInvokedSkill: string | undefined;
    readonly isSubagent: boolean;
    readonly invocation: "top_level" | "subagent";
    allowedTools: readonly string[] | undefined;
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
    ) {
        this.isSubagent = isSubagent;
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
        } else {
            this.ownedProcessRegistry = undefined;
            this.processes = processes;
        }
        this.allowedSkills = undefined;
        this.userInvokedSkill = undefined;
        this.allowedTools = undefined;
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
            throw new Error(`Read ${requestedPath} before editing it`);
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
