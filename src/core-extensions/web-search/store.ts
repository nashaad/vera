import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAuthStorage, type AuthStorage } from "../../providers/auth-storage.ts";
import { PROVIDER_ENV, SEARCH_PROVIDERS, type SearchProvider } from "./providers.ts";
import type { ProviderChoice } from "./search.ts";

export class SearchStore {
    constructor(
        private readonly directory: string,
        private readonly auth: AuthStorage = createAuthStorage(),
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly config: unknown = {},
    ) {}
    private credential(provider: SearchProvider) {
        try { return this.auth.getCredential(`vera.web-search/${provider}`); }
        catch { throw new Error("Could not read search credentials."); }
    }
    key(provider: SearchProvider): string | undefined {
        const credential = this.credential(provider);
        const variable = PROVIDER_ENV[provider];
        return (credential?.type === "api_key" ? credential.key : variable ? this.env[variable] : undefined)?.trim() || undefined;
    }
    credentialSource(provider: SearchProvider): string {
        if (provider === "duckduckgo") return "No key required";
        if (this.credential(provider)?.type === "api_key") return "Saved key";
        return this.key(provider) ? `Environment: ${PROVIDER_ENV[provider]}` : "Key missing";
    }
    saveKey(provider: SearchProvider, key: string): void {
        if (provider === "duckduckgo" || !key.trim()) throw new Error("A non-empty API key is required.");
        this.auth.setCredential(`vera.web-search/${provider}`, { type: "api_key", key: key.trim() });
    }
    removeKey(provider: SearchProvider): void {
        this.auth.deleteCredential(`vera.web-search/${provider}`);
    }
    providers(): readonly ProviderChoice[] {
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(join(this.directory, "providers.json"), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read saved search providers.");
            const configured = this.config !== null && typeof this.config === "object" ? (this.config as Record<string, unknown>).providers : undefined;
            if (configured !== undefined) {
                if (!Array.isArray(configured)) throw new Error("Search providers must be an ordered list.");
                return parseChoices(configured.map((id) => ({ id, enabled: true })));
            }
            return SEARCH_PROVIDERS.filter((id) => id === "duckduckgo" || this.key(id)).map((id) => ({ id, enabled: true }));
        }
        if (!raw || typeof raw !== "object") throw new Error("Invalid saved search providers.");
        return parseChoices((raw as Record<string, unknown>).providers);
    }
    save(providers: readonly ProviderChoice[]): void {
        const validated = parseChoices(providers);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const destination = join(this.directory, "providers.json");
        const temporary = `${destination}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ providers: validated }, null, 4) + "\n", { mode: 0o600 });
        renameSync(temporary, destination);
    }
}
function parseChoices(value: unknown): readonly ProviderChoice[] {
    if (!Array.isArray(value)) throw new Error("Invalid saved search providers.");
    const seen = new Set<string>();
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || !SEARCH_PROVIDERS.includes(entry.id)
            || typeof entry.enabled !== "boolean" || seen.has(entry.id)) throw new Error("Invalid or duplicate search provider.");
        seen.add(entry.id);
        return { id: entry.id as SearchProvider, enabled: entry.enabled };
    });
}
