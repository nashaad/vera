import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostPipe } from "../../clients/desktop/src/host-pipe.ts";
import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function serve(onConnection: (socket: Socket, request: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "vera-pipe-"));
    const path = join(dir, "s");
    const server: Server = createServer((socket) => {
        let request = "";
        socket.setEncoding("utf8");
        socket.on("error", () => {});
        socket.on("data", (chunk: string) => {
            request += chunk;
            if (request.includes("\n")) onConnection(socket, request.trim());
        });
    });
    server.listen(path);
    cleanups.push(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return path;
}

async function until(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The condition never became true.");
}

function collect(): { events: DesktopEvent[]; pipe: HostPipe } {
    const events: DesktopEvent[] = [];
    const pipe = new HostPipe((event) => events.push(event));
    cleanups.push(() => pipe.close());
    return { events, pipe };
}

test("@core replies on separate connections never mix inside one frame", async () => {
    const path = serve((socket, request) => {
        const reply = `${JSON.stringify({ type: "echo", request })}\n`;
        const middle = Math.floor(reply.length / 2);
        socket.write(reply.slice(0, middle));
        setTimeout(() => socket.end(reply.slice(middle)), request === "a" ? 40 : 10);
    });
    const { events, pipe } = collect();
    pipe.connect(path);
    pipe.send("a\n");
    pipe.send("b\n");
    await until(() => events.length === 2);
    const frames = events.map((event) => (event.type === "frame" ? event.text : ""));
    expect(frames.map((text) => JSON.parse(text).request).sort()).toEqual(["a", "b"]);
    for (const text of frames) expect(text.endsWith("\n")).toBe(true);
});

test("@core reconnecting to the same path does not report the replaced exchange as a loss", async () => {
    const path = serve((socket) => {
        setTimeout(() => socket.end(`${JSON.stringify({ type: "late" })}\n`), 80);
    });
    const { events, pipe } = collect();
    pipe.connect(path);
    pipe.send("one\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    pipe.connect(path);
    pipe.send("two\n");
    await until(() => events.some((event) => event.type === "frame"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.filter((event) => event.type === "disconnected")).toEqual([]);
    expect(events.filter((event) => event.type === "frame")).toHaveLength(1);
});

test("@core a host that closes without answering is reported as a loss", async () => {
    const path = serve((socket) => socket.end());
    const { events, pipe } = collect();
    pipe.connect(path);
    pipe.send("hello\n");
    await until(() => events.some((event) => event.type === "disconnected"));
    expect(events).toEqual([
        { type: "disconnected", reason: "The host closed the connection before it answered." },
    ]);
});

test("@core a reply with no line break past the frame cap is reported as a loss", async () => {
    const path = serve((socket) => {
        socket.write("x".repeat(1_048_576 + 1024));
    });
    const { events, pipe } = collect();
    pipe.connect(path);
    pipe.send("hello\n");
    await until(() => events.some((event) => event.type === "disconnected"));
    expect(events.some((event) => event.type === "frame")).toBe(false);
});

test("@core a missing socket is reported as a loss", async () => {
    const { events, pipe } = collect();
    pipe.connect(join(tmpdir(), "vera-pipe-missing", "s"));
    pipe.send("hello\n");
    await until(() => events.some((event) => event.type === "disconnected"));
    expect(events).toEqual([{ type: "disconnected", reason: "The host is not running." }]);
});
