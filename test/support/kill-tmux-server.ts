import { unlinkTmuxSocketFile } from "../../clients/tmux-socket-doctor.ts";
import { skippedProcessLine } from "../../src/live-process.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";
import { signalVerifiedProcess, signalVerifiedProcessGroup, type ProcessGroupIdentity } from "../../src/process-group.ts";

// Signal verified panes before the server exits, while their identities remain readable.
export function killTmuxServer(socketName: string): void {
    const panes = tmuxPanePids(socketName).map((pid) => {
        const startedAt = processStartedAt(pid);
        return { pid, started_at: startedAt === undefined ? "" : new Date(startedAt).toISOString() };
    });
    for (const pane of panes) killProcessGroup(pane);
    Bun.spawnSync(["tmux", "-L", socketName, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    unlinkTmuxSocketFile(socketName);
}

function tmuxPanePids(socketName: string): readonly number[] {
    const result = Bun.spawnSync(
        ["tmux", "-L", socketName, "list-panes", "-a", "-F", "#{pane_pid}"],
        { stdout: "pipe", stderr: "ignore" },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.toString()
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function killProcessGroup(record: ProcessGroupIdentity): void {
    if (signalVerifiedProcessGroup(record, "SIGKILL") !== "sent") {
        const outcome = signalVerifiedProcess(record, "SIGKILL");
        if (outcome !== "sent" && outcome !== "gone") process.stderr.write(skippedProcessLine(record.pid, outcome));
    }
}
