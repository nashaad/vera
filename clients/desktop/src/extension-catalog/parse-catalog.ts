import { CatalogRefusal } from "./refusal.ts";
import { MAX_CATALOG_BYTES, MAX_CATALOG_ENTRIES, parseCatalogEntry, type CatalogEntry } from "./task-protocol.ts";

export const CATALOG_TOO_LARGE = `The catalog is larger than ${MAX_CATALOG_BYTES / 1024 / 1024} MiB.`;
export const CATALOG_TOO_MANY = `The catalog lists more than ${MAX_CATALOG_ENTRIES} extensions.`;
export const CATALOG_UNREAD = "Vera could not read the catalog.";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The entries a person can install: themes for `engine` that are not withdrawn. A malformed entry is left out and the
// rest are kept; a catalog that is not the expected shape, or is too big, is refused whole.
export function parseCatalog(bytes: Uint8Array, engine: string): CatalogEntry[] {
    if (bytes.length > MAX_CATALOG_BYTES) throw new CatalogRefusal(CATALOG_TOO_LARGE);
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new CatalogRefusal(CATALOG_UNREAD);
    }
    if (!isRecord(value) || value.format !== 1 || !Array.isArray(value.extensions)) throw new CatalogRefusal(CATALOG_UNREAD);
    if (value.extensions.length > MAX_CATALOG_ENTRIES) throw new CatalogRefusal(CATALOG_TOO_MANY);
    const entries: CatalogEntry[] = [];
    const seen = new Set<string>();
    for (const raw of value.extensions) {
        if (!isRecord(raw) || raw.kind !== "theme" || raw.engine !== engine || raw.withdrawn !== false) continue;
        const entry = parseCatalogEntry(raw);
        if (entry === undefined || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
    }
    return entries;
}
