import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    classifyTmuxSocket,
    diagnoseTmuxSockets,
    liveTmuxSocketName,
    parseLiveTmuxSocketNames,
    renderTmuxSocketDoctor,
    sweepStaleTmuxSockets,
    tmuxSocketPath,
    unlinkTmuxSocketFile,
    veraOwnsTmuxSocketName,
} from "../clients/tmux-socket-doctor.ts";
import { killTmuxServer } from "./support/kill-tmux-server.ts";

test("live tmux socket names come from the tmux binary, not a shell that mentions -L", () => {
    expect(liveTmuxSocketName("tmux -L otps new-session -d -s otps")).toBe("otps");
    expect(liveTmuxSocketName("/usr/bin/tmux -L vera-load new-session -d")).toBe(
        "vera-load",
    );
    expect(liveTmuxSocketName("tmux new-session -d -s work")).toBe("default");
    expect(liveTmuxSocketName("tmux -S /tmp/tmux-501/pimem new-session -d")).toBe(
        "pimem",
    );
    expect(
        liveTmuxSocketName(
            `zsh -c 'python3 << PY\nprint("tmux -L otps")\nPY'`,
        ),
    ).toBeUndefined();

    const live = parseLiveTmuxSocketNames(`
  693 tmux -L otps new-session -d -s otps
94584 tmux -L pimem new-session -d -s p1 pi --no-session
99298 tmux -L vera-load new-session -d -s uat
79301 /bin/zsh -c builtin eval "tmux -L otps"
`);
    expect([...live].sort()).toEqual(["otps", "pimem", "vera-load"]);
});

test("Vera owns vera- prefix sockets and known UAT short names, not default or pimem", () => {
    expect(veraOwnsTmuxSocketName("vera-work-tab-1")).toBe(true);
    expect(veraOwnsTmuxSocketName("otps")).toBe(true);
    expect(veraOwnsTmuxSocketName("default")).toBe(false);
    expect(veraOwnsTmuxSocketName("pimem")).toBe(false);
    expect(veraOwnsTmuxSocketName("notes")).toBe(false);
});

test("stray sockets are Vera-owned leftovers; default and live pi stay", () => {
    const live = new Set(["otps", "pimem"]);
    expect(classifyTmuxSocket("default", live)).toMatchObject({
        stray: false,
        veraOwned: false,
    });
    expect(classifyTmuxSocket("pimem", live)).toMatchObject({
        live: true,
        stray: false,
        veraOwned: false,
    });
    expect(classifyTmuxSocket("otps", live)).toMatchObject({
        live: true,
        stray: true,
        veraOwned: true,
    });
    expect(classifyTmuxSocket("vera-work-tab-1", live)).toMatchObject({
        live: false,
        stray: true,
    });
    expect(classifyTmuxSocket("notes", live)).toMatchObject({
        stray: false,
        veraOwned: false,
    });
});

test("doctor reports leftover Vera sockets without listing every file", async () => {
    const report = await diagnoseTmuxSockets({
        directory: "/tmp/tmux-501",
        listNames: async () => [
            "default",
            "otps",
            "pimem",
            "vera-work-tab-1",
        ],
        sampleLiveNames: async () => new Set(["otps", "pimem"]),
    });

    expect(report.healthy).toBe(false);
    expect(report.sockets.filter((socket) => socket.stray).map((socket) =>
        socket.name
    )).toEqual(["otps", "vera-work-tab-1"]);
    const output = renderTmuxSocketDoctor(report);
    expect(output).toContain("Files: 4 (2 live servers, 2 leftover Vera sockets)");
    expect(output).toContain("Leftover live Vera servers: otps");
    expect(output).not.toContain("pimem");
});

test("sweep kills leftover Vera servers and unlinks leftover files, keeping default and pimem", async () => {
    const killed: string[] = [];
    const unlinked: string[] = [];
    const result = await sweepStaleTmuxSockets({
        directory: "/tmp/tmux-501",
        listNames: async () => [
            "default",
            "otps",
            "pimem",
            "vera-work-tab-1",
        ],
        sampleLiveNames: async () => new Set(["otps", "pimem"]),
        killServer: (name) => {
            killed.push(name);
        },
        unlinkSocket: (path) => {
            unlinked.push(path);
        },
    });

    expect(killed).toEqual(["otps"]);
    expect(unlinked).toEqual([
        "/tmp/tmux-501/otps",
        "/tmp/tmux-501/vera-work-tab-1",
    ]);
    expect(result).toEqual({ killedServers: 1, unlinkedFiles: 2 });
});

test("sweep unlinks leftover files in a real directory without touching default", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tmux-sweep-"));
    try {
        for (const name of ["default", "pimem", "vera-work-tab-1", "otps"]) {
            writeFileSync(join(directory, name), "");
        }
        const result = await sweepStaleTmuxSockets({
            directory,
            sampleLiveNames: async () => new Set(["pimem"]),
        });
        expect(result).toEqual({ killedServers: 0, unlinkedFiles: 2 });
        const leftover = await diagnoseTmuxSockets({
            directory,
            sampleLiveNames: async () => new Set(["pimem"]),
        });
        expect(leftover.sockets.map((socket) => socket.name).sort()).toEqual([
            "default",
            "pimem",
        ]);
        expect(leftover.healthy).toBe(true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("unlinkTmuxSocketFile never removes the default tmux socket", () => {
    const path = tmuxSocketPath("default");
    const existed = existsSync(path);
    unlinkTmuxSocketFile("default");
    expect(existsSync(path)).toBe(existed);
});

test("killTmuxServer unlinks the socket file that kill-server leaves behind", () => {
    const version = Bun.spawnSync(["tmux", "-V"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    if (version.exitCode !== 0) return;
    const name = `vera-prevent-unlink-${process.pid}`;
    const path = tmuxSocketPath(name);
    const created = Bun.spawnSync(
        ["tmux", "-L", name, "new-session", "-d", "-s", "prevent", "-x", "80", "-y", "24"],
        { stdout: "ignore", stderr: "ignore" },
    );
    try {
        if (created.exitCode !== 0 || !existsSync(path)) return;
        expect(existsSync(path)).toBe(true);
        const afterKillOnly = Bun.spawnSync(["tmux", "-L", name, "kill-server"], {
            stdout: "ignore",
            stderr: "ignore",
        });
        expect(afterKillOnly.exitCode).toBe(0);
        expect(existsSync(path)).toBe(true);
        Bun.spawnSync(
            ["tmux", "-L", name, "new-session", "-d", "-s", "prevent", "-x", "80", "-y", "24"],
            { stdout: "ignore", stderr: "ignore" },
        );
        killTmuxServer(name);
        expect(existsSync(path)).toBe(false);
    } finally {
        Bun.spawnSync(["tmux", "-L", name, "kill-server"], {
            stdout: "ignore",
            stderr: "ignore",
        });
        unlinkTmuxSocketFile(name);
    }
});
