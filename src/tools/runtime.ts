/**
 * The prior state of one file, handed to the checkpoint recorder just before a
 * `write` or `edit` overwrites it. `priorContent` is meaningful only when
 * `existedBefore` is true; for a newly created file it is the empty string.
 */
export interface FileCheckpointCapture {
    readonly path: string;
    readonly existedBefore: boolean;
    readonly priorContent: string;
    readonly tool: "write" | "edit";
}

export type FileCheckpointRecorder = (
    capture: FileCheckpointCapture,
) => Promise<void>;

export interface ToolRuntimeOptions {
    readonly recordCheckpoint?: FileCheckpointRecorder;
}

export class ToolRuntime {
    readonly workspace: string;
    private readonly fileSnapshots = new Map<string, string>();
    private mutationTail: Promise<void> = Promise.resolve();
    private readonly checkpointRecorder?: FileCheckpointRecorder;

    constructor(workspace: string, options: ToolRuntimeOptions = {}) {
        this.workspace = workspace;
        this.checkpointRecorder = options.recordCheckpoint;
    }

    /**
     * Record a file's prior state before a mutation. When no recorder is
     * configured this is a no-op, so tool execution works the same with or
     * without checkpointing wired up.
     */
    async recordCheckpoint(capture: FileCheckpointCapture): Promise<void> {
        if (this.checkpointRecorder !== undefined) {
            await this.checkpointRecorder(capture);
        }
    }

    recordFileSnapshot(path: string, content: string): void {
        this.fileSnapshots.set(path, content);
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
}
