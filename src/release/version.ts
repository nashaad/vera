// Ordering comes from Bun.semver, not a second parser. Build metadata is ignored.
export const RELEASE_VERSION_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isReleaseVersion(value: string): boolean {
    return RELEASE_VERSION_PATTERN.test(value);
}

// Strips one leading v, so tags and VERA_VERSION accept the same spelling.
export function normalizeReleaseVersion(value: string): string {
    return value.startsWith("v") ? value.slice(1) : value;
}

export function compareVersions(left: string, right: string): number {
    if (!isReleaseVersion(left)) {
        throw new Error(`Invalid version '${left}'. Expected a version like 0.1.0.`);
    }
    if (!isReleaseVersion(right)) {
        throw new Error(`Invalid version '${right}'. Expected a version like 0.1.0.`);
    }
    return Bun.semver.order(left, right);
}
