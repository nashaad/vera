import { RELEASE_VERSION_PATTERN } from "./version.ts";

// Semver 2.0.0 precedence without Bun.semver, which Electron's main process lacks. Build metadata is ignored.
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
    const a = parts(left);
    const b = parts(right);
    for (const [index, value] of a.core.entries()) {
        const difference = value - (b.core[index] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    if (a.pre.length === 0 && b.pre.length === 0) return 0;
    if (a.pre.length === 0) return 1;
    if (b.pre.length === 0) return -1;
    const shared = Math.min(a.pre.length, b.pre.length);
    for (let index = 0; index < shared; index += 1) {
        const order = compareIdentifier(a.pre[index] ?? "", b.pre[index] ?? "");
        if (order !== 0) return order;
    }
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length < b.pre.length ? -1 : 1;
}

interface VersionParts {
    readonly core: readonly [number, number, number];
    readonly pre: readonly string[];
}

function parts(version: string): VersionParts {
    const match = RELEASE_VERSION_PATTERN.exec(version);
    if (match === null) {
        throw new Error(`Invalid version '${version}'. Expected a version like 0.1.0.`);
    }
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] === undefined ? [] : match[4].slice(1).split("."),
    };
}

function compareIdentifier(left: string, right: string): -1 | 0 | 1 {
    const leftNumeric = /^[0-9]+$/.test(left);
    const rightNumeric = /^[0-9]+$/.test(right);
    if (leftNumeric && rightNumeric) {
        const difference = Number(left) - Number(right);
        return difference === 0 ? 0 : difference < 0 ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
