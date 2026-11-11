import { readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";

// WSL mounts Windows drives with these; Unix sockets and SQLite locks do not work reliably on them.
const WINDOWS_DRIVE_FILESYSTEMS = new Set(["9p", "drvfs", "v9fs"]);

// A message when the home sits on a filesystem the host cannot run from; undefined otherwise.
export function homeFilesystemProblem(home: string, mounts?: string): string | undefined {
    if (process.platform !== "linux" && mounts === undefined) return undefined;
    let table: string;
    try {
        table = mounts ?? readFileSync("/proc/mounts", "utf8");
    } catch {
        return undefined;
    }
    let path: string;
    try {
        path = realpathSync(home);
    } catch {
        path = home;
    }
    let best: { point: string; type: string } | undefined;
    for (const line of table.split("\n")) {
        const [, rawPoint, type] = line.split(" ");
        if (rawPoint === undefined || type === undefined) continue;
        const point = rawPoint.replace(/\\040/g, " ");
        const inside = path === point || path.startsWith(point === "/" ? "/" : point + sep);
        if (inside && (best === undefined || point.length > best.point.length)) best = { point, type };
    }
    if (best === undefined || !WINDOWS_DRIVE_FILESYSTEMS.has(best.type)) return undefined;
    return `${home} is on a Windows drive (${best.point}, ${best.type}), where the host's sockets and databases do not work. `
        + "Set VERA_HOME to a folder in the Linux filesystem, such as ~/.vera.";
}
