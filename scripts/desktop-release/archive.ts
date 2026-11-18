import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { run } from "./run.ts";

export interface ArchiveFile {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
}

// bsdtar stores symlinks as links and keeps modes. COPYFILE_DISABLE stops it adding ._ files for extended attributes.
// The archive appears under its final name only when whole.
export function createArchive(directory: string, entries: readonly string[], archive: string): ArchiveFile {
    const temporary = `${archive}.${process.pid}.tmp`;
    try {
        run("tar", ["-czf", temporary, "-C", directory, ...entries], { COPYFILE_DISABLE: "1" });
        renameSync(temporary, archive);
    } finally {
        rmSync(temporary, { force: true });
    }
    const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
    return { path: archive, sha256, bytes: statSync(archive).size };
}
