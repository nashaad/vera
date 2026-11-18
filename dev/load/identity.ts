export interface ProcessIdentity {
    readonly pid: number;
    readonly started: string | null;
}

export function processStart(pid: number): string | undefined {
    const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "pipe" });
    const out = result.stdout.toString().trim();
    const err = result.stderr.toString().trim();
    if (result.exitCode === 0 && out !== "") return out;
    if (result.exitCode === 1 && out === "" && err === "") return undefined;
    throw new Error(`Cannot inspect PID ${pid}: ${err || `ps exited ${result.exitCode}`}`);
}
