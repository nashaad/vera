import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// An idle process whose command line ends in clients/host/main.ts, so ps
// shows it as a Vera host. Callers must kill it.
export function spawnVeraLookingProcess(root: string): Bun.Subprocess {
    const directory = join(root, "clients", "host");
    mkdirSync(directory, { recursive: true });
    const entry = join(directory, "main.ts");
    writeFileSync(entry, "setTimeout(() => {}, 30_000);\n");
    return Bun.spawn([process.execPath, entry], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
    });
}
