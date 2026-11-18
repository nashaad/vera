#!/usr/bin/env bun
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compareVersions, isReleaseVersion, normalizeReleaseVersion } from "../src/release/version.ts";

const root = resolve(import.meta.dir, "..");

// The port the by-hand instructions and the client script's examples use.
export const FEED_PORT = 18765;

interface BuildOptions {
    readonly linux: boolean;
    // The newer release ships without desktop assets, so an update to it is held.
    readonly newerWithoutDesktop: boolean;
}

function run(args: string[], cwd = root): void {
    const result = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new Error(`${args[0]} exited ${result.exitCode}`);
}

function version(value: string | undefined): string {
    const normalized = normalizeReleaseVersion(value ?? "");
    if (!isReleaseVersion(normalized)) throw new Error(`Invalid release version: ${value}`);
    return normalized;
}

// What to run on a second Mac to install the older release with the desktop app into its real account and then update from the newer one.
export function otherMacCommands(out: string, older: string, newer: string, newerHasDesktop: boolean): string {
    const feed = `http://127.0.0.1:${FEED_PORT}`;
    const lines = [
        "To try the update by hand on another Mac, in its real account:",
        "",
        "1. On this Mac, serve the feed and leave it running:",
        `   bun ${join(root, "scripts/update-rehearsal.ts")} serve ${out} --port ${FEED_PORT}`,
        "",
        "2. On this Mac, in a second terminal, open the tunnel (USER and OTHER-MAC are the other Mac's login and name):",
        `   ssh -R 127.0.0.1:${FEED_PORT}:127.0.0.1:${FEED_PORT} USER@OTHER-MAC`,
        "",
        `3. On the other Mac, in that ssh session, install Vera ${older} with the desktop app (this opens Vera.app):`,
        `   export VERA_RELEASES_API=${feed}/releases VERA_RELEASES_DOWNLOAD_BASE=${feed}`,
        `   curl -fsS ${feed}/install.sh | VERA_VERSION=${older} VERA_DESKTOP=yes sh`,
        "   ~/.local/bin/vera --version",
        "",
        `4. In the same session, update to Vera ${newer}:`,
        "   ~/.local/bin/vera update",
        "   ~/.local/bin/vera --version",
        "   ls ~/.local/share/vera/desktop/*",
    ];
    if (!newerHasDesktop) {
        lines.push("", `Vera ${newer} has no desktop assets in this build, so step 4 holds the update.`);
    }
    return `${lines.join("\n")}\n`;
}

async function build(out: string, older: string, newer: string, options: BuildOptions): Promise<void> {
    if (compareVersions(older, newer) >= 0) throw new Error("Older version must precede newer version");
    const { linux } = options;
    const desktop = !linux && process.platform === "darwin";
    const desktopModules = join(root, "clients/desktop/node_modules");
    if (desktop && !existsSync(desktopModules)) {
        throw new Error("clients/desktop/node_modules is missing; the desktop assets need Electron from there");
    }
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), "vera-rehearsal-build-"));
    try {
        run(["git", "bundle", "create", join(work, "source.bundle"), "HEAD"]);
        for (const selected of [older, newer]) {
            const copy = join(work, selected);
            run(["git", "-c", "advice.detachedHead=false", "clone", "-q", join(work, "source.bundle"), copy]);
            const paths = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
            if (paths.exitCode !== 0) throw new Error("Could not list checkout files");
            for (const path of paths.stdout.toString().split("\0").filter(Boolean)) {
                const target = join(copy, path);
                try {
                    lstatSync(join(root, path));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    rmSync(target, { force: true, recursive: true });
                    continue;
                }
                mkdirSync(dirname(target), { recursive: true });
                rmSync(target, { recursive: true, force: true });
                cpSync(join(root, path), target, { recursive: true, verbatimSymlinks: true });
            }
            const manifest = join(copy, "src/release/manifest.ts");
            const source = readFileSync(manifest, "utf8");
            const declaration = /(export const VERA_PRODUCT_VERSION = )"[^"]+"/;
            if (!declaration.test(source)) throw new Error("Could not find copied product version");
            const changed = source.replace(declaration, `$1"${selected}"`);
            writeFileSync(manifest, changed);
            const tagOut = join(out, `v${selected}`);
            mkdirSync(tagOut, { recursive: true });
            const asset = `vera-${linux ? "linux" : process.platform}-${process.arch}.tar.gz`;
            if (linux) {
                run(["docker", "run", "--rm", "--init", "--platform", `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
                    "-v", `${copy}:/snapshot:ro`, "-v", `${tagOut}:/out`, "oven/bun:1.4.4", "sh", "-eu", "-c",
                    `apt-get update >/dev/null; apt-get install -y --no-install-recommends git ca-certificates >/dev/null; cp -a /snapshot /src; cd /src; bun install --frozen-lockfile; bun run pack:web; bun scripts/pack-release.ts --tarball /tmp/${asset}; cp /tmp/${asset} /tmp/${asset}.sha256 /out/`]);
            } else {
                run(["cp", "-Rc", join(root, "node_modules"), join(copy, "node_modules")]);
                run([process.execPath, "run", "pack:web"], copy);
                run([process.execPath, "scripts/pack-release.ts", "--tarball", join(tagOut, asset)], copy);
                if (desktop && !(selected === newer && options.newerWithoutDesktop)) {
                    run(["cp", "-Rc", desktopModules, join(copy, "clients/desktop/node_modules")]);
                    run([process.execPath, "scripts/build-desktop-release.ts", "--release", join(tagOut, asset), "--out", tagOut], copy);
                }
            }
            rmSync(copy, { recursive: true, force: true });
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    if (desktop) console.log(`\n${otherMacCommands(out, older, newer, !options.newerWithoutDesktop)}`);
}

function serve(out: string, args: string[]): void {
    let port = 8789;
    let hostname = "127.0.0.1";
    let only: string | undefined;
    let corrupt: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        switch (args[index]) {
            case "--port": port = Number(args[++index]); break;
            case "--bind": hostname = args[++index] ?? ""; break;
            case "--only": only = version(args[++index]); break;
            case "--corrupt-checksum": corrupt = version(args[++index]); break;
            default: throw new Error(`Unknown serve flag: ${args[index]}`);
        }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !hostname) throw new Error("Invalid bind or port");
    const versions = readdirSync(out).filter((name) => name.startsWith("v") && isReleaseVersion(name.slice(1)))
        .map((name) => name.slice(1)).sort((a, b) => compareVersions(b, a));
    if (versions.length === 0 || versions.length > 100) throw new Error("Feed needs between 1 and 100 releases");
    if ((only && !versions.includes(only)) || (corrupt && !versions.includes(corrupt))) throw new Error("Unknown release");
    let scenario = corrupt ? "wrong-checksum" : "normal";
    let target = corrupt ?? versions[0]!;
    let downloads = 0;
    let requests = 0;
    let completed = 0;
    let active = 0;
    let releaseTurn: (() => void) | undefined;
    const server = Bun.serve({
        hostname, port,
        async fetch(request) {
            const url = new URL(request.url);
            if (request.method === "POST" && url.pathname === "/control/scenario") {
                const mode = url.searchParams.get("mode") ?? "normal";
                const selected = url.searchParams.get("version") ?? versions[0]!;
                const listed = url.searchParams.get("only") ?? undefined;
                if (!["normal", "wrong-checksum", "truncated-tarball", "no-desktop"].includes(mode)
                    || !versions.includes(selected) || (listed && !versions.includes(listed))) {
                    return new Response("Invalid scenario\n", { status: 400 });
                }
                if (active > 0) return new Response("Provider is busy\n", { status: 409 });
                scenario = mode;
                target = selected;
                only = listed;
                downloads = requests = completed = 0;
                return new Response("ok\n");
            }
            if (request.method === "GET" && url.pathname === "/control/counts") {
                return Response.json({ downloads, requests, completed, active });
            }
            if (request.method === "POST" && url.pathname === "/control/complete-turn") {
                releaseTurn?.();
                return new Response("ok\n");
            }
            if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
                if (active > 0) return new Response("Provider is busy", { status: 429 });
                requests += 1;
                active += 1;
                const released = await new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(false), 60_000);
                    releaseTurn = () => {
                        clearTimeout(timer);
                        resolve(true);
                    };
                });
                releaseTurn = undefined;
                active -= 1;
                if (!released) return new Response("Turn timed out", { status: 504 });
                completed += 1;
                const chunk = { model: "faux-model", choices: [{ index: 0, delta: { content: "container faux passed" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
                return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            }
            if (request.method !== "GET") return new Response("Not found\n", { status: 404 });
            if (url.pathname === "/releases") {
                return Response.json(versions.filter((item) => !only || item === only).map((item) => ({
                    tag_name: `v${item}`, body: `Update rehearsal release ${item}.`, draft: false,
                })));
            }
            if (url.pathname === "/install.sh") return new Response(Bun.file(join(root, "scripts/install.sh")));
            const match = /^\/v([^/]+)\/(vera-(?:desktop-(?:shell-)?)?(?:darwin|linux)-(?:arm64|x64)\.tar\.gz)(\.sha256)?$/.exec(url.pathname);
            if (!match || !versions.includes(match[1]!)) return new Response("Not found\n", { status: 404 });
            const file = Bun.file(join(out, `v${match[1]}`, `${match[2]}${match[3] ?? ""}`));
            if (!await file.exists()) return new Response("Not found\n", { status: 404 });
            if (match[1] === target && scenario === "no-desktop" && match[2]!.startsWith("vera-desktop-")) {
                return new Response("Not found\n", { status: 404 });
            }
            downloads += 1;
            if (match[1] === target && scenario === "wrong-checksum" && match[3]) return new Response(`${"0".repeat(64)}  ${match[2]}\n`);
            if (match[1] === target && scenario === "truncated-tarball" && !match[3]) return new Response(file.slice(0, 128));
            return new Response(file);
        },
    });
    console.log(`Rehearsal feed: http://${hostname}:${server.port}`);
    const stop = (): void => { void server.stop(true); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}

if (import.meta.main) {
    try {
        const [command, output, older, newer, ...flags] = Bun.argv.slice(2);
        if (!output) throw new Error("Usage: update-rehearsal.ts build OUT OLDER NEWER [--linux] [--no-newer-desktop] | serve OUT [--port N] [--bind ADDRESS] [--only VERSION] [--corrupt-checksum VERSION]");
        if (command === "build") {
            if (flags.some((flag) => flag !== "--linux" && flag !== "--no-newer-desktop")) throw new Error("Unknown build flag");
            const linux = process.platform === "linux" || flags.includes("--linux");
            const newerWithoutDesktop = flags.includes("--no-newer-desktop");
            if (newerWithoutDesktop && linux) throw new Error("--no-newer-desktop applies to the macOS build, which is the only one with desktop assets");
            await build(resolve(output), version(older), version(newer), { linux, newerWithoutDesktop });
        } else if (command === "serve") {
            serve(resolve(output), Bun.argv.slice(4));
        } else throw new Error(`Unknown command: ${command}`);
    } catch (error) {
        console.error(`update rehearsal: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
