import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function running(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Stands in for the installed launcher. The first `update --json` is cancelled
// by SIGTERM; the second runs to the end.
function fakeVeraScript(directory: string): string {
    return `#!/bin/sh
dir=${JSON.stringify(directory)}
echo "$*" >> "$dir/calls"
case "$*" in
"update --check --json")
    printf '{"status":"available","current_version":"1.0.0","current_build":"vera-crow-1","latest_version":"1.2.3"}\\n'
    ;;
"update --json")
    runs=$(grep -c '^update --json$' "$dir/calls")
    printf '{"phase":"checking"}\\n'
    printf '{"phase":"downloading","bytes":40,"total":100}\\n'
    printf '{"phase":"waiting","sessions":[{"id":"a1","title":"Fix parser"},{"id":"b2","title":"Docs"}],"waited_ms":3000,"limit_ms":300000}\\n'
    if [ "$runs" -eq 1 ]; then
        sleep 30 &
        sleeper=$!
        trap 'kill "$sleeper" 2>/dev/null; touch "$dir/terminated"; printf "{\\"result\\":\\"cancelled\\",\\"changed\\":false}\\n"; exit 0' TERM
        wait "$sleeper"
        exit 0
    fi
    sleep 2
    printf '{"phase":"switching"}\\n'
    sleep 2
    printf '{"result":"done","version":"1.2.3","build":"vera-kraken-2","changed":true}\\n'
    ;;
esac
`;
}

test("the footer offers the update and /update cancels, then switches and relaunches", async () => {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "update-tmux-"));
    const home = join(directory, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "stub",
        model: "fixture",
        approval_mode: "auto",
        providers: {
            stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" },
        },
        updates: { mode: "ask" },
    }));
    const calls = join(directory, "calls");
    const fakeVera = join(directory, "vera");
    writeFileSync(fakeVera, fakeVeraScript(directory), { mode: 0o755 });
    const socket = join(directory, "tmux.sock");
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        USER: process.env.USER ?? "test",
        LOGNAME: process.env.USER ?? "test",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        TMPDIR: directory,
        VERA_HOME: home,
        VERA_DEV_INSTANCE: "updctl dev",
        UPDATE_TEST_COMMAND: fakeVera,
    };
    const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args], {
        cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    const run = (...args: string[]): string => {
        const result = tmux(...args);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString();
    };
    const pane = (): string => {
        const result = tmux("capture-pane", "-p", "-t", "update");
        return result.exitCode === 0 ? result.stdout.toString() : "";
    };
    const callLines = (): string[] => existsSync(calls)
        ? readFileSync(calls, "utf8").split("\n").filter((line) => line.length > 0)
        : [];
    const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}:\n${pane()}`);
            await Bun.sleep(50);
        }
    };
    let panePid = 0;
    let serverPid = 0;
    try {
        run("-f", "/dev/null", "new-session", "-d", "-s", "update", "-x", "150", "-y", "40",
            "-c", process.cwd(), "/bin/sh", "-c", 'exec "$1" "$2" 2>"$3"', "update",
            process.execPath, join(process.cwd(), "test/support/tui-update-child.ts"), join(directory, "stderr"));
        panePid = Number(run("display-message", "-p", "-t", "update", "#{pane_pid}"));
        serverPid = Number(run("display-message", "-p", "-t", "update", "#{pid}"));
        expect(panePid).toBeGreaterThan(1);
        expect(serverPid).toBeGreaterThan(1);

        await waitFor(() => pane().includes("update available: Vera 1.2.3 · /update"), "the footer notice");
        await Bun.sleep(800);
        expect(callLines().filter((line) => line === "update --check --json")).toHaveLength(1);

        run("send-keys", "-t", "update", "-l", "/update");
        await waitFor(() => pane().includes("Update Vera"), "the /update suggestion");
        run("send-keys", "-t", "update", "Enter");
        await waitFor(
            () => pane().includes("Updating · waiting for Fix parser and 1 more · 3s of 5m · Esc cancels"),
            "the waiting row",
        );
        expect(pane()).not.toContain("update available");

        run("send-keys", "-t", "update", "Escape");
        await waitFor(() => pane().includes("Update cancelled. Vera was not changed."), "the cancel notice");
        expect(existsSync(join(directory, "terminated"))).toBe(true);
        await waitFor(() => pane().includes("update available: Vera 1.2.3 · /update"), "the notice after the cancel");

        run("send-keys", "-t", "update", "-l", "/update");
        await waitFor(() => pane().includes("Update Vera"), "the /update suggestion for the second run");
        run("send-keys", "-t", "update", "Enter");
        await waitFor(() => pane().includes("Updating · waiting for Fix parser and 1 more"), "the second waiting row");
        run("send-keys", "-t", "update", "-l", "keep this draft");
        await waitFor(() => pane().includes("keep this draft"), "the draft");
        await waitFor(() => pane().includes("Updating · switching"), "the switching row");
        expect(pane()).not.toContain("Esc cancels");
        run("send-keys", "-t", "update", "Escape");
        await Bun.sleep(300);
        expect(pane()).toContain("Updating · switching");

        await waitFor(() => pane().includes("Restarting to match"), "the restart notice");
        await waitFor(() => existsSync(join(home, "relaunch.json")), "the relaunch request");
        const request: unknown = JSON.parse(readFileSync(join(home, "relaunch.json"), "utf8"));
        expect(request).toEqual({ sessionId: "update-tmux", draft: { text: "keep this draft", attachmentIds: [] } });
        expect(callLines().filter((line) => line === "update --json")).toHaveLength(2);
        await waitFor(() => !running(panePid), "the TUI to exit for the relaunch");
    } finally {
        tmux("send-keys", "-t", "update", "C-c");
        await Bun.sleep(100);
        tmux("send-keys", "-t", "update", "C-c");
        tmux("kill-server");
        for (const pid of [panePid, serverPid]) {
            if (pid <= 1) continue;
            for (let attempt = 0; attempt < 100 && running(pid); attempt += 1) {
                await Bun.sleep(50);
            }
            expect(running(pid)).toBe(false);
        }
    }
}, 90_000);
