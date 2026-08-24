import { unlinkTmuxSocketFile } from "../../clients/tmux-socket-doctor.ts";

/**
 * Tears down a UAT tmux server and reaps its panes' process groups directly.
 *
 * `tmux kill-server` alone signals only the panes tmux still knows about. A
 * pane whose shell launched a child instead of exec-ing it can outlive that
 * signal and get reparented to init, spinning forever with nothing left to
 * notice it should stop. Listing pane pids before the kill and force-killing
 * each one's process group after closes that gap without tmux's cooperation.
 *
 * `kill-server` also leaves the socket file. Unlinking it here is what stops
 * unique `-L` names from accumulating under `/tmp/tmux-<uid>`.
 */
export function killTmuxServer(socketName: string): void {
    const panePids = tmuxPanePids(socketName);
    Bun.spawnSync(["tmux", "-L", socketName, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    for (const pid of panePids) killProcessGroup(pid);
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

function killProcessGroup(pid: number): void {
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // Not a group leader of its own, or already gone; still try the pid.
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}
