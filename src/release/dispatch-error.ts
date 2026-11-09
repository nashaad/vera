export class RetainedReleaseMissingError extends Error {
    constructor(
        readonly clientBuildId: string,
        readonly hostBuildId: string,
        readonly releasePath: string,
    ) {
        super(
            `This client is ${clientBuildId}; the resident host is ${hostBuildId}. `
                + `That release is not retained at ${releasePath}. `
                + "They cannot attach. Stop the host with 'vera host stop' "
                + "so the activated build can start, or run 'vera rollback'.",
        );
        this.name = "RetainedReleaseMissingError";
    }
}
