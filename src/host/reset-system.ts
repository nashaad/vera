import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { readLaunchVeraHome } from "./launch-environment.ts";
import { processCommandLine, processIsAlive, processStartedAt } from "./process-identity.ts";
import { requestHostIdentity, type HostIdentity } from "./protocol.ts";
import type { ResetProcessSample } from "./reset-discovery.ts";
import type { ResetSystem } from "./reset.ts";

// The real OS reads behind the reset. signal() is the only call that can affect a process.
export function realResetSystem(): ResetSystem {
    return {
        listProcesses: listAllProcesses,
        launchHome: (pid) => readLaunchVeraHome(pid),
        startedAt: (pid) => processStartedAt(pid),
        unixSocketPaths,
        hostIdentity: (socketPath: string): Promise<HostIdentity | undefined> => requestHostIdentity(socketPath),
        isAlive: (pid) => processIsAlive(pid),
        commandOf: (pid) => processCommandLine(pid),
        signal(pid, signal) {
            try {
                process.kill(pid, signal);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
        },
        wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
}

function listAllProcesses(): readonly ResetProcessSample[] {
    const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const samples: ResetProcessSample[] = [];
    for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (match === null) continue;
        samples.push({ pid: Number(match[1]), command: match[2] ?? "" });
    }
    return samples;
}

// Unix socket paths the process holds. Empty when the OS does not say.
function unixSocketPaths(pid: number): readonly string[] {
    return process.platform === "darwin" ? macUnixSocketPaths(pid)
        : process.platform === "linux" ? linuxUnixSocketPaths(pid) : [];
}

function macUnixSocketPaths(pid: number): readonly string[] {
    try {
        const output = execFileSync("lsof", ["-nP", "-U", "-a", "-p", String(pid), "-Fn"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    } catch {
        return [];
    }
}

function linuxUnixSocketPaths(pid: number): readonly string[] {
    try {
        const inodes = new Set<string>();
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
            const target = readlinkSync(join(`/proc/${pid}/fd`, fd));
            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (match !== null) inodes.add(match[1] ?? "");
        }
        const paths: string[] = [];
        for (const line of readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);
            const inode = fields[6];
            const path = fields[7];
            if (inode !== undefined && path !== undefined && inodes.has(inode)) paths.push(path);
        }
        return paths;
    } catch {
        return [];
    }
}

