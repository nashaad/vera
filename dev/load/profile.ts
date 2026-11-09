import { chmod, copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { command, REPO } from "./common.ts";

function quote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ProfileRuntime {
    readonly executable: string;
    readonly flags: readonly string[];
}

export async function profileRuntime(run: string): Promise<ProfileRuntime> {
    const checkout = join(REPO, "dist", "release");
    const manifest = join(checkout, "manifest.json");
    if (!existsSync(manifest)) throw new Error("CPU profiling needs the checkout release pack");
    const root = join(run, "profile-release");
    const executable = join(root, "bun");
    await mkdir(root, { recursive: true });
    try { await command(["/bin/cp", "-c", process.execPath, executable]); }
    catch { await copyFile(process.execPath, executable); }
    await copyFile(manifest, join(root, "manifest.json"));
    for (const name of ["annex", "vera-annex", "vera-supervisor", "worker"]) {
        const source = join(checkout, name);
        if (existsSync(source)) await symlink(source, join(root, name));
    }
    const directory = relative(REPO, run);
    const worker = join(root, "session-worker");
    const entry = join(REPO, "clients", "host", "session-worker.ts");
    await writeFile(worker, `#!/bin/sh\nset -eu\nif [ "$2" = "0" ]; then\n    exec ${quote(executable)} --cpu-prof --cpu-prof-dir=${quote(directory)} --cpu-prof-name="worker-w\${2}-g\${6}.cpuprofile" ${quote(entry)} "$@"\nfi\nexec ${quote(executable)} ${quote(entry)} "$@"\n`);
    await chmod(worker, 0o755);
    return { executable, flags: ["--cpu-prof", `--cpu-prof-dir=${directory}`, "--cpu-prof-name=master.cpuprofile"] };
}
