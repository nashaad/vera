import { copyFileSync, renameSync } from "node:fs";

export function copySleep(path: string): void {
    copyFileSync("/bin/sleep", path);
    if (process.platform === "darwin") {
        // The system arm64e binary cannot run outside the signed system volume.
        const thin = `${path}.thin`;
        const lipo = Bun.spawnSync(["/usr/bin/lipo", path, "-thin", "x86_64", "-output", thin]);
        if (lipo.exitCode !== 0) throw new Error(lipo.stderr.toString());
        renameSync(thin, path);
        const sign = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", path]);
        if (sign.exitCode !== 0) throw new Error(sign.stderr.toString());
    }
}
