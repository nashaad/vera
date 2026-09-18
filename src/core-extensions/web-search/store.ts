import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VeraSearchProviderInfo } from "../../sdk/extensions.ts";
import { createAuthStorage, type AuthStorage } from "../../providers/auth-storage.ts";
import { BUILT_IN_PROVIDERS } from "./providers.ts";

export interface SavedChoice { readonly id: string; readonly enabled: boolean }
export interface ProviderEntry<P extends VeraSearchProviderInfo> { readonly provider: P; readonly enabled: boolean }

export class SearchStore<P extends VeraSearchProviderInfo> {
    constructor(
        private readonly directory: string,
        private readonly registered: () => readonly P[],
        private readonly auth: AuthStorage = createAuthStorage(),
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly config: unknown = {},
    ) {}
    private credential(provider: VeraSearchProviderInfo) {
        try { return this.auth.getCredential(`vera.web-search/${provider.id}`); }
        catch { throw new Error("Could not read search credentials."); }
    }
    key(provider: VeraSearchProviderInfo): string | undefined {
        const credential = this.credential(provider);
        return (credential?.type === "api_key" ? credential.key
            : provider.keyEnv ? this.env[provider.keyEnv] : undefined)?.trim() || undefined;
    }
    credentialSource(provider: VeraSearchProviderInfo): string {
        if (!provider.requiresKey && this.credential(provider)?.type !== "api_key" && !this.key(provider)) return "No key required";
        if (this.credential(provider)?.type === "api_key") return "Saved key";
        return this.key(provider) ? `Environment: ${provider.keyEnv}` : "Key missing";
    }
    saveKey(provider: VeraSearchProviderInfo, key: string): void {
        if (!key.trim()) throw new Error("A non-empty API key is required.");
        this.auth.setCredential(`vera.web-search/${provider.id}`, { type: "api_key", key: key.trim() });
    }
    removeKey(provider: VeraSearchProviderInfo): void {
        this.auth.deleteCredential(`vera.web-search/${provider.id}`);
    }
    /** Built-in providers appear once connected; other extensions' providers always appear, new ones last. */
    providers(): readonly ProviderEntry<P>[] {
        const registered = this.registered();
        const byId = new Map(registered.map((provider) => [provider.id, provider]));
        const saved = this.saved();
        const listed = saved ?? registered
            .filter((provider) => isBuiltIn(provider.id) && this.key(provider))
            .map((provider) => ({ id: provider.id, enabled: true }));
        const choices = listed.flatMap((entry): ProviderEntry<P>[] => {
            const provider = byId.get(entry.id);
            return provider ? [{ provider, enabled: entry.enabled }] : [];
        });
        const seen = new Set(listed.map((entry) => entry.id));
        for (const provider of registered) {
            if (!isBuiltIn(provider.id) && !seen.has(provider.id)) choices.push({ provider, enabled: true });
        }
        return choices;
    }
    available(): readonly P[] {
        const listed = new Set(this.providers().map((entry) => entry.provider.id));
        return this.registered().filter((provider) => !listed.has(provider.id));
    }
    save(choices: readonly ProviderEntry<VeraSearchProviderInfo>[]): void {
        const validated = parseChoices(choices.map((entry) => ({ id: entry.provider.id, enabled: entry.enabled })));
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const destination = join(this.directory, "providers.json");
        const temporary = `${destination}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ providers: validated }, null, 4) + "\n", { mode: 0o600 });
        renameSync(temporary, destination);
    }
    private saved(): readonly SavedChoice[] | undefined {
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(join(this.directory, "providers.json"), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read saved search providers.");
            const configured = this.config !== null && typeof this.config === "object" ? (this.config as Record<string, unknown>).providers : undefined;
            if (configured === undefined) return undefined;
            if (!Array.isArray(configured)) throw new Error("Search providers must be an ordered list.");
            return parseChoices(configured.map((id) => ({ id, enabled: true })));
        }
        if (!raw || typeof raw !== "object") throw new Error("Invalid saved search providers.");
        return parseChoices((raw as Record<string, unknown>).providers);
    }
}

export function isBuiltIn(id: string): boolean {
    return (BUILT_IN_PROVIDERS as readonly string[]).includes(id);
}

function parseChoices(value: unknown): readonly SavedChoice[] {
    if (!Array.isArray(value)) throw new Error("Invalid saved search providers.");
    const seen = new Set<string>();
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string"
            || typeof entry.enabled !== "boolean" || seen.has(entry.id)) throw new Error("Invalid or duplicate search provider.");
        seen.add(entry.id);
        return { id: entry.id, enabled: entry.enabled };
    });
}
