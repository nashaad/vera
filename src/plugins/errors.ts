export class PluginManifestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginManifestError";
    }
}
