import { expect, test } from "bun:test";
import { gateFor, probeSockets, type SocketProbe } from "./socket-probe.ts";

const bothPass: SocketProbe = { unix: true, loopback: true };
const unixFails: SocketProbe = { unix: false, loopback: true };
const loopbackFails: SocketProbe = { unix: true, loopback: false };

test("a gate runs its tests when every transport it needs passes", () => {
    expect(gateFor(bothPass, ["unix"])).toBe(test);
    expect(gateFor(bothPass, ["unix", "loopback"])).toBe(test);
    expect(gateFor(loopbackFails, ["unix"])).toBe(test);
});

test("a gate skips its tests when a transport it needs fails", () => {
    expect(gateFor(unixFails, ["unix"])).toBe(test.skip);
    expect(gateFor(loopbackFails, ["loopback"])).toBe(test.skip);
    expect(gateFor(loopbackFails, ["unix", "loopback"])).toBe(test.skip);
});

test("a transport whose attempt throws is recorded as failed", async () => {
    const probe = await probeSockets(async (transport) => {
        if (transport === "loopback") throw new Error("address in use");
    }, 1_000);
    expect(probe).toEqual({ unix: true, loopback: false });
});

test("a transport whose attempt never settles is recorded as failed", async () => {
    const probe = await probeSockets(() => new Promise<void>(() => {}), 20);
    expect(probe).toEqual({ unix: false, loopback: false });
});
