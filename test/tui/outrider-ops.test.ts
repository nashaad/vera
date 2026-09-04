/** The three routes into a local runtime: nothing on the machine, a binary that answers, and a binary that fails. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    installOutrider,
    outriderBinary,
    outriderPresence,
    outriderProfiles,
    rememberOutriderBinary,
    serveOutrider,
    type OutriderDriver,
    type RuntimeCommand,
} from "../../clients/tui/main/outrider-ops.ts";

interface Answer {
    readonly ok?: boolean;
    readonly stdout?: string;
    readonly detail?: string;
}

/** A stand-in Outrider. Every command it was asked to run is kept, so a test can say what Vera actually invoked. */
function driver(
    binary: string | undefined,
    answers: Record<string, Answer> = {},
): OutriderDriver & { readonly ran: string[][] } {
    const ran: string[][] = [];
    return {
        ran,
        binary: () => binary,
        run(command): RuntimeCommand {
            ran.push([...command]);
            const verb = command.find((word) =>
                ["ps", "ls", "serve"].includes(word)
            ) ?? "";
            const answer = answers[verb] ?? {};
            return {
                finished: Promise.resolve({
                    ok: answer.ok ?? true,
                    stdout: answer.stdout ?? "",
                    detail: answer.detail ?? "",
                }),
                stop: () => {},
            };
        },
    };
}

describe("driving a local runtime", () => {
    test("no binary is absent, and nothing is run to find that out", async () => {
        const outrider = driver(undefined);
        expect(await outriderPresence(outrider)).toEqual({ state: "absent" });
        expect(outrider.ran).toEqual([]);
    });

    test("nothing on the machine has no roster to offer", async () => {
        const outrider = driver(undefined);
        expect(await outriderProfiles(outrider)).toEqual([]);
        expect(outrider.ran).toEqual([]);
    });

    test("installing does not need a binary, because it is what places one", () => {
        const outrider = driver(undefined);
        installOutrider(() => {}, outrider);
        expect(outrider.ran).toHaveLength(1);
        expect(outrider.ran[0]?.[0]).toBe("sh");
    });

    test("a binary that answers is asked where it is, by its path", async () => {
        const outrider = driver("/Users/x/.local/bin/outrider", {
            ps: {
                stdout: JSON.stringify({
                    kind: "running",
                    endpoint: "http://127.0.0.1:11435",
                    preset: "qwen35-2b",
                    health: true,
                }),
            },
        });
        expect(await outriderPresence(outrider)).toEqual({
            state: "running",
            endpoint: "http://127.0.0.1:11435",
            profile: "qwen35-2b",
        });
        expect(outrider.ran[0]?.[0]).toBe("/Users/x/.local/bin/outrider");
    });

    test("the roster is the catalog's own ids, in its own order", async () => {
        const outrider = driver("/opt/outrider", {
            ls: {
                stdout: JSON.stringify({
                    profiles: [{ id: "qwen35b-mtp" }, { id: "qwen35-2b" }],
                }),
            },
        });
        expect(await outriderProfiles(outrider)).toEqual([
            "qwen35b-mtp",
            "qwen35-2b",
        ]);
    });

    test("a catalog that cannot be read leaves the roster empty, not wrong", async () => {
        const outrider = driver("/opt/outrider", {
            ls: { ok: false, stdout: "who knows" },
        });
        expect(await outriderProfiles(outrider)).toEqual([]);
    });

    test("a runtime that is up but unwell is not somewhere to point a provider", async () => {
        const outrider = driver("/opt/outrider", {
            ps: { stdout: JSON.stringify({ kind: "running", health: false }) },
        });
        expect((await outriderPresence(outrider)).state).toBe("stopped");
    });

    test("a failed start says what the runtime said, so a remedy survives", async () => {
        const said = "outrider: cached model checksum mismatch, delete the"
            + " cached file and serve it again";
        const outrider = driver("/opt/outrider", {
            serve: { ok: false, detail: said },
        });
        const result = await serveOutrider("qwen35-2b", () => {}, outrider)
            .finished;
        expect(result.ok).toBe(false);
        expect(result.detail).toBe(said);
    });

    test("a second attempt runs the same command again, which is the recovery", async () => {
        const outrider = driver("/opt/outrider", {
            serve: { ok: false, detail: "checksum mismatch" },
        });
        await serveOutrider("qwen35-2b", () => {}, outrider).finished;
        await serveOutrider("qwen35-2b", () => {}, outrider).finished;
        expect(outrider.ran).toEqual([
            ["/opt/outrider", "--json", "serve", "qwen35-2b"],
            ["/opt/outrider", "--json", "serve", "qwen35-2b"],
        ]);
    });

    test("progress reaches the caller while a command is in flight", () => {
        const seen: string[] = [];
        const outrider: OutriderDriver = {
            binary: () => "/opt/outrider",
            run(_command, onProgress) {
                onProgress({ name: "qwen35-2b", done: false, total: 10 });
                onProgress({ name: "qwen35-2b", done: true, total: 10 });
                return {
                    finished: Promise.resolve({
                        ok: true,
                        stdout: "",
                        detail: "",
                    }),
                    stop: () => {},
                };
            },
        };
        serveOutrider("qwen35-2b", (line) => seen.push(line.name), outrider);
        expect(seen).toEqual(["qwen35-2b", "qwen35-2b"]);
    });
});

describe("what an install leaves behind", () => {
    test("the path an install reported is what gets run afterwards", () => {
        const placed = join(
            mkdtempSync(join(tmpdir(), "outrider-ops-")),
            "outrider",
        );
        writeFileSync(placed, "#!/bin/sh\n", { mode: 0o755 });
        rememberOutriderBinary(placed);
        expect(outriderBinary()).toBe(placed);
    });

    test("a path that is no longer there falls back to the search", () => {
        const gone = join(
            mkdtempSync(join(tmpdir(), "outrider-ops-")),
            "outrider",
        );
        rememberOutriderBinary(gone);
        expect(outriderBinary()).not.toBe(gone);
    });
});
