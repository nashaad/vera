import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hostSocketPathProblem } from "../../src/host/startup-failure.ts";
import { buildFactory, FACTORY_VERSION, type FactoryManifest } from "./factory.ts";

const RUNS = "load-runs";
const FACTORIES = "load-factories";
const MARKER = ".load-owner.json";

export const REPORT_RETENTION = { count: 8, bytes: 1024 ** 3 };
export const FACTORY_RETENTION = { count: 1, bytes: 2 * 1024 ** 3 };

export interface RetentionLimit {
    readonly count: number;
    readonly bytes: number;
}

interface OwnerMarker {
    readonly kind: "run" | "factory";
    readonly version: 1;
    readonly state: "active" | "complete";
    readonly created: number;
    readonly pid: number;
    readonly alias?: string;
    readonly seed?: number;
    readonly small?: boolean;
    readonly workspace?: string;
    readonly factoryVersion?: number;
}

interface OwnedDirectory {
    readonly path: string;
    readonly marker: OwnerMarker;
    readonly bytes: number;
}

export class ArtifactSetupCleanupError extends Error {}

async function directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    if (!(await lstat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
}

async function writeMarker(path: string, marker: OwnerMarker): Promise<void> {
    const temporary = join(path, `${MARKER}.tmp`);
    await writeFile(temporary, JSON.stringify(marker));
    await rename(temporary, join(path, MARKER));
}

async function readMarker(path: string, kind: OwnerMarker["kind"]): Promise<OwnerMarker | undefined> {
    try {
        if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, MARKER))).isFile()) return undefined;
        const marker = JSON.parse(await readFile(join(path, MARKER), "utf8")) as OwnerMarker;
        if (marker.kind !== kind || marker.version !== 1 || marker.state !== "complete"
            || !Number.isFinite(marker.created) || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) return undefined;
        return marker;
    } catch {
        return undefined;
    }
}

async function sizeOf(path: string): Promise<number> {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let bytes = 0;
    for await (const entry of await opendir(path)) bytes += await sizeOf(join(path, entry.name));
    return bytes;
}

async function ownedDirectories(parent: string, kind: OwnerMarker["kind"]): Promise<OwnedDirectory[]> {
    const found: OwnedDirectory[] = [];
    await directory(parent);
    for await (const entry of await opendir(parent)) {
        if (!entry.isDirectory() || !/^[a-z]+-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        const path = join(parent, entry.name);
        const marker = await readMarker(path, kind);
        if (marker !== undefined) found.push({ path, marker, bytes: await sizeOf(path) });
    }
    return found;
}

export async function pruneOwned(parent: string, kind: OwnerMarker["kind"], limit: RetentionLimit, protectedPath?: string): Promise<void> {
    const owned = await ownedDirectories(parent, kind);
    owned.sort((a, b) => b.marker.created - a.marker.created || b.path.localeCompare(a.path));
    let count = 0;
    let bytes = 0;
    for (const entry of owned) {
        if (entry.path === protectedPath) {
            count++;
            bytes += entry.bytes;
        }
    }
    for (const entry of owned) {
        if (entry.path === protectedPath) continue;
        if (count < limit.count && bytes + entry.bytes <= limit.bytes) {
            count++;
            bytes += entry.bytes;
        } else {
            await rm(entry.path, { recursive: true });
        }
    }
}

export class RunArtifacts {
    private constructor(readonly run: string, readonly alias: string, private readonly marker: OwnerMarker) {}

    get home(): string { return join(this.alias, "r", "home"); }

    static async create(root: string): Promise<RunArtifacts> {
        const runs = join(root, RUNS);
        await directory(runs);
        const run = await mkdtemp(join(runs, "run-"));
        let alias: string | undefined;
        try {
            alias = await mkdtemp(join(tmpdir(), "vera-dev", "hl-"));
            const home = join(alias, "r", "home");
            const problem = hostSocketPathProblem(home);
            if (problem !== undefined) throw problem;
            await mkdir(join(run, "home"));
            await symlink(run, join(alias, "r"));
            const marker: OwnerMarker = { kind: "run", version: 1, state: "active", created: Date.now(), pid: process.pid, alias };
            await writeMarker(run, marker);
            return new RunArtifacts(run, alias, marker);
        } catch (error) {
            try {
                if (alias !== undefined) await rm(alias, { recursive: true, force: true });
                await rm(run, { recursive: true, force: true });
            } catch (cleanup) {
                throw new ArtifactSetupCleanupError(`Setup cleanup failed for ${run} and ${alias ?? "no alias"}: ${cleanup}`, { cause: error });
            }
            throw error;
        }
    }

    static async recover(root: string, run: string, alias: string, pid: number): Promise<void> {
        if (dirname(run) !== join(root, RUNS) || !/^run-[A-Za-z0-9]{6}$/.test(basename(run))
            || dirname(alias) !== join(tmpdir(), "vera-dev") || !/^hl-[A-Za-z0-9]{6}$/.test(basename(alias))) {
            throw new Error(`Invalid recorded run or alias: ${run}`);
        }
        if (!(await lstat(run)).isDirectory() || !(await lstat(join(run, MARKER))).isFile()) {
            throw new Error(`Cannot verify run ownership: ${run}`);
        }
        const marker = JSON.parse(await readFile(join(run, MARKER), "utf8")) as OwnerMarker;
        if (marker.kind !== "run" || marker.version !== 1 || marker.pid !== pid || marker.alias !== alias
            || (marker.state !== "active" && marker.state !== "complete")) {
            throw new Error(`Cannot verify run ownership: ${run}`);
        }
        const aliasInfo = await lstat(alias).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        if (aliasInfo !== undefined) {
            if (!aliasInfo.isDirectory()) throw new Error(`Cannot verify run alias: ${alias}`);
            const entries = await readdir(alias);
            if (entries.length > 0 && (entries.length !== 1 || entries[0] !== "r"
                || !(await lstat(join(alias, "r"))).isSymbolicLink() || await readlink(join(alias, "r")) !== run)) {
                throw new Error(`Cannot verify run alias: ${alias}`);
            }
        }
        await new RunArtifacts(run, alias, marker).finish();
    }

    async finish(): Promise<void> {
        for (const name of ["home", "workspace", "user", "profile-release", "factory-staging"]) {
            await rm(join(this.run, name), { recursive: true, force: true });
        }
        await rm(this.alias, { recursive: true, force: true });
        await writeMarker(this.run, { ...this.marker, state: "complete" });
    }
}

export async function removeActive(active: string, run: string): Promise<void> {
    try {
        if (!(await lstat(active)).isSymbolicLink() || await readlink(active) !== run) {
            throw new Error(`Active link changed: ${active}`);
        }
        await rm(active);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export async function factoryFor(root: string, run: string, seed: number, small: boolean, workspace: string): Promise<{ path: string; manifest: FactoryManifest }> {
    const parent = join(root, FACTORIES);
    for (const entry of await ownedDirectories(parent, "factory")) {
        const marker = entry.marker;
        if (marker.seed === seed && marker.small === small && marker.workspace === workspace && marker.factoryVersion === FACTORY_VERSION) {
            const path = join(entry.path, "data");
            return { path, manifest: await buildFactory({ root: path, seed, workspace, small }) };
        }
    }
    const staging = join(run, "factory-staging");
    const container = join(parent, `factory-${randomBytes(3).toString("hex")}`);
    const marker: OwnerMarker = { kind: "factory", version: 1, state: "active", created: Date.now(), pid: process.pid,
        seed, small, workspace, factoryVersion: FACTORY_VERSION };
    try {
        await mkdir(staging);
        await writeMarker(staging, marker);
        const manifest = await buildFactory({ root: join(staging, "data"), seed, workspace, small });
        await writeMarker(staging, { ...marker, state: "complete" });
        await rename(staging, container);
        return { path: join(container, "data"), manifest };
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
}

export async function pruneRetained(root: string, currentRun: string): Promise<void> {
    await pruneOwned(join(root, RUNS), "run", REPORT_RETENTION, currentRun);
    await pruneOwned(join(root, FACTORIES), "factory", FACTORY_RETENTION);
}
