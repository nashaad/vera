import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachLine, SessionPipe } from "../../clients/desktop/src/session-pipe.ts";
import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Fake {
    readonly path: string;
    readonly received: string[];
    readonly sockets: Socket[];
}

// Records every line each client writes, in arrival order across connections.
function serve(onConnection?: (socket: Socket, index: number) => void): Fake {
    const dir = mkdtempSync(join(tmpdir(), "vera-session-"));
    const path = join(dir, "s");
    const fake: { path: string; received: string[]; sockets: Socket[] } = { path, received: [], sockets: [] };
    const server: Server = createServer((socket) => {
        let buffered = "";
        const index = fake.sockets.length;
        fake.sockets.push(socket);
        socket.setEncoding("utf8");
        socket.on("error", () => {});
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            for (;;) {
                const newline = buffered.indexOf("\n");
                if (newline === -1) break;
                fake.received.push(buffered.slice(0, newline + 1));
                buffered = buffered.slice(newline + 1);
            }
        });
        onConnection?.(socket, index);
    });
    server.listen(path);
    cleanups.push(() => {
        for (const socket of fake.sockets) socket.destroy();
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return fake;
}

async function until(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The condition never became true.");
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
}

function collect(hidesReasoning: () => boolean = () => false): { events: DesktopEvent[]; pipe: SessionPipe } {
    const events: DesktopEvent[] = [];
    const pipe = new SessionPipe((event) => events.push(event), "subagent", hidesReasoning);
    cleanups.push(() => pipe.close());
    return { events, pipe };
}

const ATTACH_AGENT_A = `${JSON.stringify({
    type: "attach",
    agent_id: "agent-a",
    requested_capabilities: ["agent.history-paging.v1", "session.title.v1", "host.stop-wait.v1"],
})}\n`;

test("@core watch attaches with the history and stop-wait capabilities and emits each host line", async () => {
    const fake = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "one" })}\n${JSON.stringify({ type: "two" })}\n`);
        socket.write('{"type":"thr');
        setTimeout(() => socket.write('ee"}\n'), 20);
    });
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => events.length === 3);
    expect(fake.received[0]).toBe(ATTACH_AGENT_A);
    expect(events).toEqual([
        { type: "session_frame", pane: "subagent", agentId: "agent-a", text: `${JSON.stringify({ type: "one" })}\n` },
        { type: "session_frame", pane: "subagent", agentId: "agent-a", text: `${JSON.stringify({ type: "two" })}\n` },
        { type: "session_frame", pane: "subagent", agentId: "agent-a", text: `${JSON.stringify({ type: "three" })}\n` },
    ]);
});

test("@core only the main pane and Chat tabs ask to have screens opened for them", async () => {
    const fake = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "session_show", agent_id: "agent-a", target: "dialog.themes" })}\n`);
    });
    const events: DesktopEvent[] = [];
    const pipe = new SessionPipe((event) => events.push(event), "main", () => false);
    cleanups.push(() => pipe.close());
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => events.length === 1);
    expect(JSON.parse(fake.received[0] ?? "{}").requested_capabilities).toEqual([
        "agent.history-paging.v1",
        "session.title.v1",
        "host.stop-wait.v1",
        "session.show-window.v1",
    ]);
    expect(events[0]).toEqual({
        type: "session_frame",
        pane: "main",
        agentId: "agent-a",
        text: `${JSON.stringify({ type: "session_show", agent_id: "agent-a", target: "dialog.themes" })}\n`,
    });
    expect(JSON.parse(ATTACH_AGENT_A).requested_capabilities).not.toContain("session.show-window.v1");
    expect(JSON.parse(attachLine("agent-a", false, "chat:2")).requested_capabilities).toContain("session.show-window.v1");
    expect(JSON.parse(attachLine("agent-a", false, "subagent")).requested_capabilities).not.toContain("session.show-window.v1");
    expect(JSON.parse(attachLine("agent-a", false, "subagent")).requested_capabilities).not.toContain("session.show-window.v1");
});

test("@core a host restart notice reaches the page as a session frame before the watch closes", async () => {
    const notice = `${JSON.stringify({ type: "host_restarting", build_id: "build-2" })}\n`;
    const fake = serve((socket) => {
        socket.write(notice);
        setTimeout(() => socket.end(), 20);
    });
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => events.length === 2);
    expect(events[0]).toEqual({ type: "session_frame", pane: "subagent", agentId: "agent-a", text: notice });
    expect(events[1]).toMatchObject({ type: "session_closed", pane: "subagent", agentId: "agent-a" });
});

test("send writes a request line on the open watch", async () => {
    const fake = serve();
    const { pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    pipe.send('{"type":"history"}\n');
    await until(() => fake.received.length === 2);
    expect(fake.received[1]).toBe('{"type":"history"}\n');
});

test("a redirect re-opens the watch on the new socket path without emitting the redirect line", async () => {
    const target = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "moved-frame" })}\n`);
    });
    const origin = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "agent_location_changed", socket_path: target.path })}\n`);
    });
    const { events, pipe } = collect();
    pipe.connect(origin.path);
    pipe.watch("agent-a");
    await until(() => events.length === 1);
    expect(target.received).toEqual([ATTACH_AGENT_A]);
    expect(events).toEqual([
        { type: "session_frame", pane: "subagent", agentId: "agent-a", text: `${JSON.stringify({ type: "moved-frame" })}\n` },
    ]);
});

test("a second redirect closes the session with a reason", async () => {
    const last = serve();
    const middle = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "agent_location_changed", socket_path: last.path })}\n`);
    });
    const origin = serve((socket) => {
        socket.write(`${JSON.stringify({ type: "agent_location_changed", socket_path: middle.path })}\n`);
    });
    const { events, pipe } = collect();
    pipe.connect(origin.path);
    pipe.watch("agent-a");
    await until(() => events.length === 1);
    await settle();
    expect(events).toEqual([
        { type: "session_closed", pane: "subagent", agentId: "agent-a", reason: "The host moved this session more than once." },
    ]);
    expect(last.received).toEqual([]);
});

test("unwatch writes a detach line, closes, and emits nothing", async () => {
    const fake = serve();
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    pipe.unwatch();
    await until(() => fake.received.length === 2);
    expect(fake.received[1]).toBe('{"type":"detach"}\n');
    await settle();
    expect(events).toEqual([]);
});

test("a host-side close emits session_closed once", async () => {
    const fake = serve((socket, index) => {
        if (index === 0) setTimeout(() => socket.end(), 20);
    });
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => events.length >= 1);
    await settle();
    expect(events).toEqual([
        { type: "session_closed", pane: "subagent", agentId: "agent-a", reason: "The host closed this session." },
    ]);
});

test("a missing host reports that the host is not running", async () => {
    const { events, pipe } = collect();
    pipe.connect(join(tmpdir(), "vera-session-missing", "s"));
    pipe.watch("agent-a");
    await until(() => events.length === 1);
    expect(events).toEqual([
        { type: "session_closed", pane: "subagent", agentId: "agent-a", reason: "The host is not running." },
    ]);
});

test("a replaced watch emits nothing from its old socket", async () => {
    const fake = serve();
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    pipe.watch("agent-b");
    await until(() => fake.received.length === 2);
    expect(fake.received[1]).toBe(
        `${JSON.stringify({ type: "attach", agent_id: "agent-b", requested_capabilities: ["agent.history-paging.v1", "session.title.v1", "host.stop-wait.v1"] })}\n`,
    );
    fake.sockets[0]?.write(`${JSON.stringify({ type: "stale" })}\n`);
    await settle();
    expect(events).toEqual([]);
    fake.sockets[1]?.write(`${JSON.stringify({ type: "fresh" })}\n`);
    await until(() => events.length === 1);
    expect(events).toEqual([
        { type: "session_frame", pane: "subagent", agentId: "agent-b", text: `${JSON.stringify({ type: "fresh" })}\n` },
    ]);
});

function capabilitiesOf(line: string | undefined): unknown {
    return (JSON.parse(line ?? "{}") as { requested_capabilities?: unknown }).requested_capabilities;
}

test("@core a watch asks for reasoning progress only while reasoning is hidden", async () => {
    const fake = serve();
    let hidden = true;
    const { pipe } = collect(() => hidden);
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    expect(capabilitiesOf(fake.received[0])).toEqual(["agent.history-paging.v1", "session.title.v1", "host.stop-wait.v1", "agent.reasoning-progress.v1"]);
    hidden = false;
    pipe.watch("agent-a");
    await until(() => fake.received.length === 2);
    expect(capabilitiesOf(fake.received[1])).toEqual(["agent.history-paging.v1", "session.title.v1", "host.stop-wait.v1"]);
});

test("@core a redirected watch reads the reasoning choice again when it attaches", async () => {
    let hidden = true;
    const target = serve();
    const origin = serve((socket) => {
        socket.once("data", () => {
            hidden = false;
            socket.write(`${JSON.stringify({ type: "agent_location_changed", socket_path: target.path })}\n`);
        });
    });
    const { pipe } = collect(() => hidden);
    pipe.connect(origin.path);
    pipe.watch("agent-a");
    await until(() => target.received.length === 1);
    expect(capabilitiesOf(origin.received[0])).toContain("agent.reasoning-progress.v1");
    expect(capabilitiesOf(target.received[0])).toEqual(["agent.history-paging.v1", "session.title.v1", "host.stop-wait.v1"]);
});

test("@core reattach opens the same agent again with the current choice and drops the old socket", async () => {
    const fake = serve();
    let hidden = false;
    const { events, pipe } = collect(() => hidden);
    pipe.connect(fake.path);
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    hidden = true;
    pipe.reattach();
    await until(() => fake.received.length === 2);
    expect(JSON.parse(fake.received[1] ?? "{}")).toMatchObject({ type: "attach", agent_id: "agent-a" });
    expect(capabilitiesOf(fake.received[1])).toContain("agent.reasoning-progress.v1");
    fake.sockets[0]?.write(`${JSON.stringify({ type: "stale" })}\n`);
    fake.sockets[1]?.write(`${JSON.stringify({ type: "fresh" })}\n`);
    await until(() => events.length === 1);
    await settle();
    expect(events).toEqual([
        { type: "session_frame", pane: "subagent", agentId: "agent-a", text: `${JSON.stringify({ type: "fresh" })}\n` },
    ]);
});

test("reattach does nothing without an open watch", async () => {
    const fake = serve();
    const { events, pipe } = collect();
    pipe.connect(fake.path);
    pipe.reattach();
    pipe.watch("agent-a");
    await until(() => fake.received.length === 1);
    pipe.unwatch();
    pipe.reattach();
    await settle();
    expect(fake.sockets).toHaveLength(1);
    expect(events).toEqual([]);
});
