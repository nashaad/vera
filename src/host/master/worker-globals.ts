import { join } from "node:path";

import type { PermissionPreference } from "../../engine/permission-preferences.ts";
import { loadPermissionPreferences } from "../../engine/permission-preferences.ts";
import type { PermissionPredicate } from "../../engine/permissions.ts";
import type { SuggestedModel } from "../../model/supported-models.ts";
import type { ProviderCatalogState } from "../../providers/catalog-state.ts";
import { defaultAuthStoragePath } from "../../providers/auth-storage.ts";
import { fileReadStamp } from "../../store/read-cache.ts";
import { HostConnectionClosedError } from "../connection.ts";
import type { WorkerControlLink } from "./worker-link.ts";
import type { CredentialLease } from "./credentials.ts";
import type { GlobalChange, PoolCommit } from "./global-services.ts";

interface CatalogSnapshot {
    readonly models: readonly SuggestedModel[];
    readonly providerCatalogs: readonly ProviderCatalogState[];
    readonly refreshableProviders: readonly string[];
}

export class WorkerGlobals {
    private catalog?: CatalogSnapshot;
    private catalogStamp?: string;
    private catalogRequest?: Promise<void>;
    private catalogGeneration = 0;
    private preferences: readonly PermissionPreference[] = [];
    private preferenceGeneration = 0;

    constructor(
        private readonly peer: WorkerControlLink,
        private readonly home: string,
        private readonly configPath: string,
        private readonly preferencesPath: string,
    ) {}

    async initialize(): Promise<void> {
        this.preferences = await this.peer.request<readonly PermissionPreference[]>("globals.preferences");
    }

    lease(provider: string, rejected?: string, signal?: AbortSignal): Promise<CredentialLease> {
        return this.peer.request("globals.credential", [provider, rejected], signal);
    }

    async ensureCatalog(): Promise<void> {
        while (true) {
            const stamp = this.readCatalogStamp();
            if (this.catalog !== undefined && this.catalogStamp === stamp) return;
            if (this.catalogRequest === undefined) {
                const generation = this.catalogGeneration;
                this.catalogRequest = this.peer.request<CatalogSnapshot>("globals.catalog").then((catalog) => {
                    if (generation === this.catalogGeneration) {
                        this.catalog = catalog;
                        this.catalogStamp = stamp;
                    }
                }).finally(() => { this.catalogRequest = undefined; });
            }
            try {
                await this.catalogRequest;
            } catch (error) {
                if (error instanceof HostConnectionClosedError) return;
                throw error;
            }
        }
    }

    models(): readonly SuggestedModel[] { return this.catalog?.models ?? []; }
    hasCatalog(): boolean { return this.catalog !== undefined; }
    providerCatalogs(): readonly ProviderCatalogState[] { return this.catalog?.providerCatalogs ?? []; }
    refreshableProviders(): readonly string[] { return this.catalog?.refreshableProviders ?? []; }

    async refreshCatalog(provider: string): Promise<readonly SuggestedModel[] | undefined> {
        const result = await this.peer.request<readonly SuggestedModel[] | undefined>("globals.refreshCatalog", [provider]);
        if (result !== undefined) {
            this.catalog = undefined;
            await this.ensureCatalog();
        }
        return result;
    }

    async changed(kind: GlobalChange): Promise<void> {
        if (kind === "preferences") {
            await this.reloadPreferences();
            return;
        }
        this.catalogGeneration += 1;
        this.catalog = undefined;
        this.catalogStamp = undefined;
    }

    readonly permissionPreferences = {
        list: (): readonly PermissionPreference[] => this.preferences,
        add: async (when: PermissionPredicate): Promise<PermissionPreference> => {
            const added = await this.peer.request<PermissionPreference>("globals.preferenceAdd", [when]);
            await this.reloadPreferences();
            return added;
        },
        remove: async (id: string): Promise<boolean> => {
            const removed = await this.peer.request<boolean>("globals.preferenceRemove", [id]);
            await this.reloadPreferences();
            return removed;
        },
    };

    request<T>(method: string, ...args: readonly unknown[]): Promise<T> {
        return this.peer.request<T>(`globals.${method}`, args);
    }

    commitPool(commit: PoolCommit): Promise<void> {
        return this.request("poolCommit", commit);
    }

    private readCatalogStamp(): string {
        return [
            this.configPath,
            defaultAuthStoragePath(this.home),
            join(this.home, "pool.json"),
            join(this.home, "runtime", "cache"),
        ].map((path) => fileReadStamp(path) ?? "").join("\n");
    }

    private async reloadPreferences(): Promise<void> {
        const generation = ++this.preferenceGeneration;
        const preferences = await loadPermissionPreferences(this.preferencesPath);
        if (generation === this.preferenceGeneration) this.preferences = preferences;
    }
}
