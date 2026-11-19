import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../../ui/src/extensions/manifest.ts";
import type { CatalogListResult, CatalogPreviewResult } from "../../../ui/src/protocol/extension-catalog.ts";
import {
    CATALOG_UNREACHABLE,
    DOWNLOAD_FAILED,
    type CatalogEntry,
    type CatalogReply,
    type CatalogTask,
} from "../extension-catalog/task-protocol.ts";
import type { ExtensionService } from "./service.ts";
import type { ExtensionStore } from "./store.ts";

export type RunCatalogTask = (task: CatalogTask) => Promise<CatalogReply>;

const NOT_LISTED = "That extension is not in the catalog.";
const NOT_THE_ONE = "The package is not the one the catalog lists.";
const PACKAGE_FILE = "package.tgz";

// The extension catalog behind Discover. The list is fetched in a task process when Discover opens and held in memory
// only until it closes. A theme is downloaded into a staging folder, then goes through `ExtensionService.preview`, which
// checks the sha256 before unpacking and is the only way an extension reaches the installed folder.
export class ExtensionCatalogService {
    private held = new Map<string, CatalogEntry>();
    // Bumped on every open and close, so an answer that arrives after Discover moved on is dropped.
    private generation = 0;

    constructor(
        private readonly address: string | undefined,
        private readonly store: ExtensionStore,
        private readonly extensions: ExtensionService,
        private readonly run: RunCatalogTask,
    ) {}

    async open(): Promise<CatalogListResult> {
        const generation = ++this.generation;
        this.held = new Map();
        if (this.address === undefined) return { ok: true, available: false };
        let reply: CatalogReply;
        try {
            reply = await this.run({ kind: "list", url: this.address, engine: DESKTOP_ENGINE });
        } catch {
            return { ok: false, reason: CATALOG_UNREACHABLE };
        }
        if (!reply.ok) return reply;
        if (reply.kind !== "list") return { ok: false, reason: CATALOG_UNREACHABLE };
        if (generation !== this.generation) return { ok: true, available: true, themes: [] };
        this.held = new Map(reply.entries.map((entry) => [entry.id, entry]));
        const installed = new Map(this.store.entries().map((entry) => [entry.id, entry.version]));
        return {
            ok: true,
            available: true,
            themes: reply.entries.map(({ id, name, version, palette }) => ({ id, name, version, palette, installed: installed.get(id) === version })),
        };
    }

    async preview(id: string): Promise<CatalogPreviewResult> {
        const entry = this.held.get(id);
        if (entry === undefined) return { ok: false, reason: NOT_LISTED };
        const generation = this.generation;
        const folder = this.store.newStaging();
        try {
            const packagePath = join(folder, PACKAGE_FILE);
            let reply: CatalogReply;
            try {
                reply = await this.run({ kind: "download", url: entry.url, size: entry.size, destination: packagePath });
            } catch {
                return { ok: false, reason: DOWNLOAD_FAILED };
            }
            if (!reply.ok) return reply;
            if (reply.kind !== "download") return { ok: false, reason: DOWNLOAD_FAILED };
            if (generation !== this.generation) return { ok: false, reason: NOT_LISTED };
            return await this.unpack(entry, packagePath);
        } finally {
            this.store.discard(folder);
        }
    }

    close(): void {
        this.generation += 1;
        this.held = new Map();
    }

    private async unpack(entry: CatalogEntry, packagePath: string): Promise<CatalogPreviewResult> {
        const result = await this.extensions.preview(packagePath, entry.sha256);
        if (!result.ok) return result;
        const { preview } = result;
        if (preview === undefined) return { ok: false, reason: DOWNLOAD_FAILED };
        const themes = this.extensions.stagedThemes(preview.token);
        if (preview.id !== entry.id || preview.version !== entry.version || themes === undefined || themes.length === 0) {
            this.extensions.cancel(preview.token);
            return { ok: false, reason: NOT_THE_ONE };
        }
        return {
            ok: true,
            preview: {
                token: preview.token,
                id: preview.id,
                name: entry.name,
                version: preview.version,
                ...(preview.replaces === undefined ? {} : { replaces: preview.replaces }),
                themes,
            },
        };
    }
}
