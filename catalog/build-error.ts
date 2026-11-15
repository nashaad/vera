// A problem with the catalog sources that the person editing them can fix.
export class CatalogBuildError extends Error {}

export function fail(message: string): never {
    throw new CatalogBuildError(message);
}
