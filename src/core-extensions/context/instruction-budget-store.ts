import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, opendirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS = 500;

interface NoticeMarker {
    readonly path: string;
    readonly name: string;
    readonly modifiedAt: number;
}

function removeMarker(path: string): void {
    try {
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function readMarker(directory: string, name: string): NoticeMarker | undefined {
    const path = join(directory, name);
    try {
        const stat = lstatSync(path);
        return stat.isFile() ? { path, name, modifiedAt: stat.mtimeMs } : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function pruneInstructionBudgetNotices(path: string): void {
    const directory = opendirSync(path);
    const retained: NoticeMarker[] = [];
    try {
        let entry = directory.readSync();
        while (entry !== null) {
            if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name)) {
                const marker = readMarker(path, entry.name);
                if (marker !== undefined) {
                    let position = 0;
                    while (position < retained.length && (
                        retained[position]!.modifiedAt < marker.modifiedAt
                        || (retained[position]!.modifiedAt === marker.modifiedAt
                            && retained[position]!.name < marker.name)
                    )) position++;
                    retained.splice(position, 0, marker);
                    if (retained.length > MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS) {
                        removeMarker(retained.shift()!.path);
                    }
                }
            }
            entry = directory.readSync();
        }
    } finally {
        directory.closeSync();
    }
}

export function claimInstructionBudgetNotice(storage: string, conversationId: string): boolean {
    const directory = join(storage, "instruction-budget-notices");
    const name = createHash("sha256").update(conversationId).digest("hex");
    const path = join(directory, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let claimed = true;
    try {
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        claimed = false;
    }
    try {
        pruneInstructionBudgetNotices(directory);
    } catch (error) {
        if (claimed) {
            try {
                removeMarker(path);
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Could not prune or undo the notice claim");
            }
        }
        throw error;
    }
    return claimed;
}
