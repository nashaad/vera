import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_LINK_HOPS = 40;

export function canonicalPath(path: string, hops = 0): string {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    } catch {
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const candidate = join(canonicalPath(parent, hops), basename(absolute));
    if (hops >= MAX_LINK_HOPS) return candidate;
    let target: string;
    try {
        target = readlinkSync(candidate);
    } catch {
        return candidate;
    }
    return canonicalPath(resolve(dirname(candidate), target), hops + 1);
}
