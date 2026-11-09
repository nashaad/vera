import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { processIdentityState, signalVerifiedProcess } from "../src/process-group.ts";
import { testTempBase } from "./support/temp-root.ts";

interface Scenario {
    readonly name: string;
    readonly code: (root: string, pidPath: string) => string;
}

const scenarios: readonly Scenario[] = [
    {
        name: "command hook",
        code: (_root, pidPath) => `
            const { createCommandHook } = await import('./src/extensions/command-hook.ts');
            const script = ${JSON.stringify(`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`)};
            const hook = createCommandHook({ phase: 'session_start', timeoutMs: 150, argv: [process.execPath, '-e', script] });
            try { await hook({ type: 'session_start', sessionId: 's', workspace: process.cwd(), reason: 'start' }); } catch {}
        `,
    },
    {
        name: "skill script",
        code: (root, pidPath) => `
            const { runSkillScript } = await import('./src/skills/script.ts');
            const path = ${JSON.stringify(join(root, "slow.sh"))};
            await Bun.write(path, ${JSON.stringify(`#!/bin/sh\necho $$ > ${JSON.stringify(pidPath)}\nexec sleep 60\n`)});
            await import('node:fs/promises').then((fs) => fs.chmod(path, 0o755));
            await runSkillScript({ scriptPath: path, args: [], workspace: ${JSON.stringify(root)}, skillDirectory: ${JSON.stringify(root)}, timeoutMs: 150, signal: new AbortController().signal });
        `,
    },
    {
        name: "sidecar",
        code: (root, pidPath) => `
            const { SupervisedSidecar } = await import('./src/host/sidecar-runtime.ts');
            const script = ${JSON.stringify(`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`)};
            const task = new SupervisedSidecar({
                sidecar: { id: 'test/sidecar', localId: 'sidecar', extensionId: 'test', extensionDirectory: ${JSON.stringify(root)}, definition: { id: 'sidecar', command: [process.execPath, '-e', script], env: {}, restart: false } },
                socketPath: ${JSON.stringify(join(root, "host.sock"))}, logPath: ${JSON.stringify(join(root, "sidecar.log"))},
                timing: { stopGraceMs: 500 },
            });
            task.start();
            for (let n = 0; n < 200 && !await Bun.file(${JSON.stringify(pidPath)}).exists(); n++) await Bun.sleep(10);
            await task.stop();
        `,
    },
    {
        name: "process tool",
        code: (root, pidPath) => `
            const { ManagedProcessRegistry } = await import('./src/tools/process-runtime.ts');
            const registry = new ManagedProcessRegistry({ stopWaitMs: 1000 });
            const scope = registry.scope('s');
            const result = await scope.run({ command: ${JSON.stringify(`echo $$ > ${JSON.stringify(pidPath)}; exec sleep 60`)}, cwd: ${JSON.stringify(root)}, env: process.env, yieldAfterMs: 100, interactive: false });
            if (result.kind !== 'running') throw new Error('process did not start');
            await scope.kill(result.snapshot.processId);
            await registry.close();
        `,
    },
    {
        name: "worker handle",
        code: (root, pidPath) => `
            const { SessionStore } = await import('./src/store/session-store.ts');
            const { startWorker } = await import('./src/host/worker/handle.ts');
            const path = ${JSON.stringify(join(root, "session.jsonl"))};
            const store = await SessionStore.create(path, { sessionId: 's', cwd: ${JSON.stringify(root)} });
            const header = JSON.parse((await Bun.file(path).text()).split('\\n')[0]);
            const script = ${JSON.stringify(`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`)};
            const worker = await startWorker({ store, session: { path, header, records: [] }, model: 'test', adapter: { module: 'unused', options: {} }, command: [process.execPath, '-e', script] });
            for (let n = 0; n < 200 && !await Bun.file(${JSON.stringify(pidPath)}).exists(); n++) await Bun.sleep(10);
            worker.kill();
            await worker.outcome;
            await worker.supervisor?.exited;
        `,
    },
    {
        name: "tmux test cleanup",
        code: (root, pidPath) => `
            const { killTmuxServer } = await import('./test/support/kill-tmux-server.ts');
            const script = ${JSON.stringify(`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`)};
            const pane = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'ignore' });
            for (let n = 0; n < 200 && !await Bun.file(${JSON.stringify(pidPath)}).exists(); n++) await Bun.sleep(10);
            const tmux = ${JSON.stringify(join(root, "tmux"))};
            await Bun.write(tmux, '#!/bin/sh\\nif [ "$4" = "list-panes" ]; then echo ' + pane.pid + '; fi\\n');
            await import('node:fs/promises').then((fs) => fs.chmod(tmux, 0o755));
            process.env.TMUX_TMPDIR = ${JSON.stringify(root)};
            try { killTmuxServer('hs9-' + process.pid); }
            finally { pane.kill('SIGKILL'); await pane.exited; }
        `,
    },
];

for (const scenario of scenarios) {
    test(`${scenario.name} does not signal a group when its leader check fails`, async () => {
        const root = await mkdtemp(join(testTempBase(), "group-path-"));
        const pidPath = join(root, "child.pid");
        const startedAt = new Date().toISOString();
        const ps = join(root, "ps");
        await writeFile(ps, '#!/bin/sh\nif [ "$1" = "-axo" ] && [ "$2" = "pid=,pgid=,stat=,etime=" ]; then /bin/ps "$@" | /usr/bin/awk \'{$2 = $1 + 1; print}\'; exit 0; fi\nexec /bin/ps "$@"\n');
        await chmod(ps, 0o755);
        const source = `
            const originalKill = process.kill.bind(process);
            const groups = [];
            process.kill = (pid, signal) => {
                if (pid < 0) { groups.push(pid); throw Object.assign(new Error('blocked'), { code: 'EPERM' }); }
                return originalKill(pid, signal);
            };
            ${scenario.code(root, pidPath)}
            console.log('GROUP_RESULT:' + JSON.stringify(groups));
        `;
        const runner = Bun.spawn([process.execPath, "-e", source], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root, VERA_HOME: join(root, "home"), VERA_DEV_INSTANCE: "hsplit9 dev" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = new Response(runner.stdout).text();
        const stderr = new Response(runner.stderr).text();
        try {
            const code = await Promise.race([runner.exited, Bun.sleep(8_000).then(() => null)]);
            expect(code).toBe(0);
            const output = await stdout;
            expect(output).toContain("GROUP_RESULT:[]");
            expect(await stderr).toBe("");
        } finally {
            runner.kill("SIGKILL");
            await runner.exited;
            const pid = Number((await readFile(pidPath, "utf8").catch(() => "")).trim());
            if (pid > 0) {
                const record = { pid, started_at: startedAt };
                const state = processIdentityState(record);
                if (state === "same") signalVerifiedProcess(record, "SIGKILL");
                if (state === "unverified") throw new Error(`Could not confirm PID ${pid} is still the process that was listed; left it running.`);
                const deadline = Date.now() + 2_000;
                while (processIdentityState(record) === "same" && Date.now() < deadline) await Bun.sleep(10);
                expect(processIdentityState(record)).not.toBe("same");
            }
            await rm(root, { recursive: true, force: true });
        }
    }, 12_000);
}
