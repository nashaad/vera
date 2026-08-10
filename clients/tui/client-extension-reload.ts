/** Details from a client-extension generation that activated incompletely. */
export class ClientExtensionReloadPartialFailure extends Error {
    readonly kind: "none" | "some";
    readonly loadedExtensionIds: readonly string[];
    readonly failures: readonly string[];

    constructor(
        kind: "none" | "some",
        details: string,
        loadedExtensionIds: readonly string[],
        failures: readonly string[],
    ) {
        super(details);
        this.name = "ClientExtensionReloadPartialFailure";
        this.kind = kind;
        this.loadedExtensionIds = loadedExtensionIds;
        this.failures = failures;
    }
}

/** Keep extension failures useful in a notice and bounded in the transcript. */
export function boundedExtensionReloadFailure(message: string): string {
    const compact = message.replaceAll(/\s+/g, " ").trim();
    return compact.length <= 240
        ? compact
        : `${compact.slice(0, 239).trimEnd()}…`;
}
