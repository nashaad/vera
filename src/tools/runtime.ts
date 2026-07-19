export class ToolRuntime {
    readonly workspace: string;
    private readonly fileSnapshots = new Map<string, string>();
    private mutationTail: Promise<void> = Promise.resolve();

    constructor(workspace: string) {
        this.workspace = workspace;
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
