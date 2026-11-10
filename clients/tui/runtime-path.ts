import { dirname, join, resolve, sep } from "node:path";

export function runtimePath(sourcePath: string, releasePath: string): string {
    const releaseRoot = dirname(process.execPath);
    const entry = process.argv[1];
    if (entry !== undefined && resolve(entry).startsWith(join(releaseRoot, "bundle") + sep)) {
        return join(releaseRoot, releasePath);
    }
    return sourcePath;
}
