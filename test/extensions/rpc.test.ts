import { expect, test } from "bun:test";
import {
    PassThrough,
    Writable,
} from "node:stream";

import {
    createExtensionRpcPeer,
    ExtensionRpcRemoteError,
    parseExtensionRpcFrame,
    type ExtensionRpcPeer,
} from "../../src/extensions/rpc.ts";

test("RPC frames accept only the fixed protocol shapes", () => {
    expect(parseExtensionRpcFrame({
        type: "request",
        requestId: "h1",
        method: "activate",
        params: { rpcVersion: 1 },
    })).toEqual({
        type: "request",
        requestId: "h1",
        method: "activate",
        params: { rpcVersion: 1 },
    });
    expect(parseExtensionRpcFrame({
        type: "result",
        requestId: "e1",
        value: null,
    })).toEqual({
        type: "result",
        requestId: "e1",
        value: null,
    });
    expect(parseExtensionRpcFrame({
        type: "error",
        requestId: "h2",
        code: "timeout",
        message: "too slow",
    })).toEqual({
        type: "error",
        requestId: "h2",
        code: "timeout",
        message: "too slow",
    });
    expect(parseExtensionRpcFrame({
        type: "cancel",
        requestId: "e2",
    })).toEqual({
        type: "cancel",
        requestId: "e2",
    });

    expect(parseExtensionRpcFrame(null)).toBeUndefined();
    expect(parseExtensionRpcFrame({
        type: "request",
        requestId: "",
        method: "activate",
        params: null,
    })).toBeUndefined();
    expect(parseExtensionRpcFrame({
        type: "request",
        requestId: "h3",
        method: "surprise",
        params: null,
    })).toBeUndefined();
    expect(parseExtensionRpcFrame({
        type: "error",
        requestId: "h4",
        code: "surprise",
        message: "bad",
    })).toBeUndefined();
    expect(parseExtensionRpcFrame({
        type: "cancel",
        requestId: "h5",
        value: null,
    })).toBeUndefined();
});

test("RPC peers call handlers concurrently in both directions", async () => {
    const peers = createPeerPair();
    peers.a.register("capability", async (params) => {
        expect(params).toEqual({ value: 4 });
        return { value: 8 };
    });
    peers.b.register("invoke", async () => "vera");

    try {
        const [doubled, name] = await Promise.all([
            peers.b.request("capability", { value: 4 }, { timeoutMs: 100 }),
            peers.a.request("invoke", null, { timeoutMs: 100 }),
        ]);
        expect(doubled).toEqual({ value: 8 });
        expect(name).toBe("vera");
    } finally {
        peers.close();
    }
});

test("a handler can make a reverse capability call", async () => {
    const peers = createPeerPair();
    peers.a.register("capability", async () => ({
        text: "summary",
    }));
    peers.b.register("invoke", async (_params, context) => {
        const result = await peers.b.request(
            "capability",
            { messages: ["old context"] },
            { timeoutMs: 100, signal: context.signal },
        );
        return { projection: result };
    });

    try {
        await expect(peers.a.request(
            "invoke",
            { targetTokens: 100 },
            { timeoutMs: 100 },
        )).resolves.toEqual({
            projection: { text: "summary" },
        });
    } finally {
        peers.close();
    }
});

test("timeout cancels the remote handler and the peer remains usable", async () => {
    const peers = createPeerPair();
    let cancelled = false;
    peers.b.register("invoke", async (_params, context) => {
        await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
                cancelled = true;
                resolve();
            }, { once: true });
        });
        return null;
    });
    peers.b.register("capability", async (params) => params);

    try {
        await expect(peers.a.request(
            "invoke",
            null,
            { timeoutMs: 5 },
        )).rejects.toThrow("timed out after 5ms");
        await Bun.sleep(0);
        expect(cancelled).toBe(true);
        await expect(peers.a.request(
            "capability",
            "ready",
            { timeoutMs: 100 },
        )).resolves.toBe("ready");
    } finally {
        peers.close();
    }
});

test("unknown methods and handler failures are attributed remote errors", async () => {
    const peers = createPeerPair();
    peers.b.register("invoke", async () => {
        throw new Error("bad extension");
    });

    try {
        await expect(peers.a.request(
            "dispose",
            null,
            { timeoutMs: 100 },
        )).rejects.toMatchObject({
            name: "ExtensionRpcRemoteError",
            code: "unknown_handler",
        });
        await expect(peers.a.request(
            "invoke",
            null,
            { timeoutMs: 100 },
        )).rejects.toEqual(
            new ExtensionRpcRemoteError("handler_failed", "bad extension"),
        );
    } finally {
        peers.close();
    }
});

test("malformed input closes the peer and rejects pending calls", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const peer = createExtensionRpcPeer({
        input: incoming,
        output: outgoing,
        label: "test",
        requestIdPrefix: "h",
    });
    const pending = peer.request("invoke", null, { timeoutMs: 1_000 });

    incoming.write("not json\n");
    await expect(pending).rejects.toThrow("received malformed JSON");
    expect(peer.closed).toBe(true);
});

test("a duplicate live request ID closes the peer", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const peer = createExtensionRpcPeer({
        input: incoming,
        output: outgoing,
        label: "test",
        requestIdPrefix: "h",
    });
    peer.register("invoke", async (_params, context) => {
        await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
                once: true,
            });
        });
        return null;
    });
    const request = JSON.stringify({
        type: "request",
        requestId: "e1",
        method: "invoke",
        params: null,
    });

    incoming.write(`${request}\n${request}\n`);
    await waitFor(() => peer.closed);

    expect(peer.closed).toBe(true);
});

test("a duplicate ID is fatal while an unknown-handler reply is pending", async () => {
    const incoming = new PassThrough();
    const outgoing = new Writable({
        write(_chunk, _encoding, _callback): void {
            // Hold the first error reply open.
        },
    });
    const peer = createExtensionRpcPeer({
        input: incoming,
        output: outgoing,
        label: "test",
        requestIdPrefix: "h",
    });
    const request = JSON.stringify({
        type: "request",
        requestId: "e1",
        method: "invoke",
        params: null,
    });

    incoming.write(`${request}\n${request}\n`);
    await waitFor(() => peer.closed);

    expect(peer.closed).toBe(true);
});

test("unknown replies and cancels are ignored", async () => {
    const peers = createPeerPair();
    peers.a.register("capability", async (params) => params);

    try {
        const wire = (peers as PeerPairWithWires).bToA;
        wire.write(`${JSON.stringify({
            type: "result",
            requestId: "h999",
            value: null,
        })}\n`);
        wire.write(`${JSON.stringify({
            type: "cancel",
            requestId: "h999",
        })}\n`);
        await expect(peers.b.request(
            "capability",
            "ready",
            { timeoutMs: 100 },
        )).resolves.toBe("ready");
    } finally {
        peers.close();
    }
});

test("an oversized unterminated frame closes the peer", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const peer = createExtensionRpcPeer({
        input: incoming,
        output: outgoing,
        label: "test",
        requestIdPrefix: "h",
        maxLineBytes: 8,
    });

    incoming.write("123456789");
    await waitFor(() => peer.closed);

    expect(peer.closed).toBe(true);
});

test("closing aborts active handlers and rejects pending calls", async () => {
    const peers = createPeerPair();
    let aborted = false;
    peers.b.register("invoke", async (_params, context) => {
        await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
                aborted = true;
                resolve();
            }, { once: true });
        });
        return null;
    });

    const pending = peers.a.request("invoke", null, { timeoutMs: 1_000 });
    await Bun.sleep(0);
    peers.b.close();

    await expect(pending).rejects.toThrow(/closed|input ended|Premature close/);
    expect(aborted).toBe(true);
    peers.a.close();
});

test("an output failure closes the peer and rejects the request", async () => {
    const input = new PassThrough();
    const output = new Writable({
        write(_chunk, _encoding, callback): void {
            callback(new Error("broken pipe"));
        },
    });
    const peer = createExtensionRpcPeer({
        input,
        output,
        label: "test",
        requestIdPrefix: "h",
    });

    await expect(peer.request(
        "invoke",
        null,
        { timeoutMs: 100 },
    )).rejects.toThrow("broken pipe");
    expect(peer.closed).toBe(true);
});

test("output closure closes the peer and rejects pending calls", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = createExtensionRpcPeer({
        input,
        output,
        label: "test",
        requestIdPrefix: "h",
    });
    const pending = peer.request(
        "invoke",
        null,
        { timeoutMs: 1_000 },
    );
    await Bun.sleep(0);

    output.destroy();

    await expect(pending).rejects.toThrow("output closed");
    expect(peer.closed).toBe(true);
});

test("output finish closes the peer even when close events are disabled", async () => {
    const input = new PassThrough();
    const output = new PassThrough({ emitClose: false });
    const peer = createExtensionRpcPeer({
        input,
        output,
        label: "test",
        requestIdPrefix: "h",
    });
    const pending = peer.request(
        "invoke",
        null,
        { timeoutMs: 1_000 },
    );
    await Bun.sleep(0);

    output.end();

    await expect(pending).rejects.toThrow("output ended");
    expect(peer.closed).toBe(true);
});

interface PeerPair {
    readonly a: ExtensionRpcPeer;
    readonly b: ExtensionRpcPeer;
    close(): void;
}

interface PeerPairWithWires extends PeerPair {
    readonly bToA: PassThrough;
}

function createPeerPair(): PeerPairWithWires {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = createExtensionRpcPeer({
        input: bToA,
        output: aToB,
        label: "A",
        requestIdPrefix: "h",
    });
    const b = createExtensionRpcPeer({
        input: aToB,
        output: bToA,
        label: "B",
        requestIdPrefix: "e",
    });
    return {
        a,
        b,
        bToA,
        close(): void {
            a.close();
            b.close();
        },
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }
        await Bun.sleep(0);
    }
    throw new Error("condition was not reached");
}
