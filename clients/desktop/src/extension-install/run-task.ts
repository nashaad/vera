import { readExtension } from "../extensions/read-extension.ts";
import { ExtensionRefusal } from "./refusal.ts";
import type { InstallReply, InstallTask } from "./task-protocol.ts";
import { checkSha256, packageEntries, readPackage, unpackEntries } from "./unpack.ts";

// Checks the package, unpacks it into the staging folder and says what it holds. Installing is main's step.
export function runInstallTask(task: InstallTask): InstallReply {
    try {
        const bytes = readPackage(task.packagePath);
        if (task.sha256 !== undefined) checkSha256(bytes, task.sha256);
        unpackEntries(packageEntries(bytes), task.staging);
        const read = readExtension(task.staging);
        if (!read.ok) return { ok: false, reason: read.reason };
        const { manifest } = read;
        return {
            ok: true,
            preview: {
                id: manifest.id,
                version: manifest.version,
                themes: manifest.themes.map((theme) => theme.label),
                hasMain: manifest.main !== undefined,
                hasCommands: manifest.commands.length > 0,
            },
        };
    } catch (error) {
        if (error instanceof ExtensionRefusal) return { ok: false, reason: error.message };
        throw error;
    }
}
