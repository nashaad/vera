export type PreimageRecorder = (
    path: string,
    content: string,
) => Promise<void>;

export class ToolRuntime {
    readonly workspace: string;
    /**
     * The directory project-scoped state is keyed on. Equal to the workspace
     * unless the owner resolved a repository root for it.
     */
    readonly instructionRoot: string;
    /** Where captured pre-images land, for messages that point at them. */
    readonly stashDirectory: string | undefined;
    /**
     * Extra variables layered over the inherited environment in every shell
     * this session's tools spawn. The owner chooses the variables; the tools
     * layer only carries them.
     */
    readonly env: Readonly<Record<string, string>> | undefined;
    /**
     * The skills the worn agent may reach, or `undefined` for all of them.
     *
     * Set on the runtime rather than passed per call because the gate is a
     * property of the session, not of the invocation: `skill_script` has to
     * refuse a skill the catalog never showed, however it was named.
     */
    allowedSkills: readonly string[] | undefined;
    /** The tools the worn agent may call, or `undefined` for all of them. */
    allowedTools: readonly string[] | undefined;
    private readonly fileSnapshots = new Map<string, string>();
    private readonly preimageRecorder: PreimageRecorder | undefined;
    private mutationTail: Promise<void> = Promise.resolve();

    constructor(
        workspace: string,
        preimageRecorder?: PreimageRecorder,
        stashDirectory?: string,
        env?: Readonly<Record<string, string>>,
        instructionRoot?: string,
    ) {
        this.workspace = workspace;
        this.instructionRoot = instructionRoot ?? workspace;
        this.preimageRecorder = preimageRecorder;
        this.stashDirectory = stashDirectory;
        this.env = env;
        this.allowedSkills = undefined;
        this.allowedTools = undefined;
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
