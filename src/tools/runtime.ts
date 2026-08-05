export type PreimageRecorder = (
    path: string,
    content: string,
) => Promise<void>;

export class ToolRuntime {
    readonly workspace: string;
    private readonly fileSnapshots = new Map<string, string>();
    private readonly preimageRecorder: PreimageRecorder | undefined;
    private mutationTail: Promise<void> = Promise.resolve();

    constructor(workspace: string, preimageRecorder?: PreimageRecorder) {
        this.workspace = workspace;
        this.preimageRecorder = preimageRecorder;
    }

    recordFileSnapshot(path: string, content: string): void {
        this.fileSnapshots.set(path, content);
    }

    /**
     * Preserves a file's contents before its first mutation. Failures never
     * block the mutation itself: the stash is a recovery aid, not a gate.
     */
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
}
