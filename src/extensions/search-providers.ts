import type { VeraExtensionDisposer, VeraSearchProvider } from "../sdk/extensions.ts";

interface OwnedSearchProvider {
    readonly owner: string;
    readonly provider: VeraSearchProvider;
}

/** Search providers from every loaded extension on one side, in load order. */
export class SearchProviderSet {
    private readonly entries: OwnedSearchProvider[] = [];

    add(owner: string, provider: VeraSearchProvider): VeraExtensionDisposer {
        const checked = validateSearchProvider(provider);
        const existing = this.entries.find((entry) => entry.provider.id === checked.id);
        if (existing !== undefined) {
            throw new Error(`Duplicate search provider ${checked.id}, already registered by ${existing.owner}`);
        }
        const entry = { owner, provider: checked };
        this.entries.push(entry);
        return () => {
            const index = this.entries.indexOf(entry);
            if (index >= 0) this.entries.splice(index, 1);
        };
    }

    list(): readonly VeraSearchProvider[] {
        return this.entries.map((entry) => entry.provider);
    }

    withdraw(owner: string): void {
        for (let index = this.entries.length - 1; index >= 0; index -= 1) {
            if (this.entries[index]!.owner === owner) this.entries.splice(index, 1);
        }
    }
}

function validateSearchProvider(provider: VeraSearchProvider): VeraSearchProvider {
    if (typeof provider !== "object" || provider === null) throw new Error("Invalid search provider");
    if (typeof provider.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(provider.id)) {
        throw new Error("Search provider id must be lowercase letters, digits, and dashes");
    }
    if (typeof provider.label !== "string" || !provider.label.trim()) throw new Error("Search provider needs a label");
    if (typeof provider.requiresKey !== "boolean") throw new Error("Search provider must say whether it requires a key");
    if (provider.keyEnv !== undefined && (typeof provider.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(provider.keyEnv))) {
        throw new Error("Search provider keyEnv must be an environment variable name");
    }
    if (typeof provider.search !== "function") throw new Error("Search provider needs a search function");
    return Object.freeze({
        id: provider.id,
        label: provider.label.trim(),
        requiresKey: provider.requiresKey,
        ...(provider.keyEnv === undefined ? {} : { keyEnv: provider.keyEnv }),
        search: provider.search.bind(provider),
    });
}
