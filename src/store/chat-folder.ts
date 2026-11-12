import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function chatFolderPath(sessionPath: string): string {
    return `${sessionPath}.files`;
}

// The home or temp path may be reached through a symlink, so a plain string compare can miss.
export function isChatFolder(sessionPath: string, cwd: string): boolean {
    const folder = chatFolderPath(sessionPath);
    if (cwd === folder) return true;
    if (basename(cwd) !== basename(folder)) return false;
    try {
        return join(realpathSync(dirname(cwd)), basename(cwd))
            === join(realpathSync(dirname(folder)), basename(folder));
    } catch {
        return false;
    }
}
