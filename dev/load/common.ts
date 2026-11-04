import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const LOAD_ROOT = join(tmpdir(), "vera-dev", "host-load");

export function assertTrialHome(home = process.env.VERA_HOME): string {
    if (!home) throw new Error("VERA_HOME must be set under $TMPDIR/vera-dev/");
    const base = resolve(tmpdir(), "vera-dev");
    const path = resolve(home);
    if (!path.startsWith(`${base}/`)) throw new Error(`Unsafe trial home: ${path}`);
    mkdirSync(path, { recursive: true });
    if (!realpathSync(path).startsWith(`${realpathSync(base)}/`)) {
        throw new Error("Trial home resolves outside vera-dev");
    }
    return path;
}

export function log(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...value as object })}\n`);
}

export function rows<T>(path: string): T[] {
    try {
        return readFileSync(path, "utf8").trim().split("\n")
            .filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

export function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ state >>> 15, state | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function hash(text: string): number {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return value >>> 0;
}

export function summary(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return {
        count: values.length,
        mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        p50: percentile(.5), p90: percentile(.9), p99: percentile(.99),
        max: sorted.at(-1) ?? null,
        over250: values.filter((value) => value > 250).length,
    };
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await Bun.sleep(100);
    }
}

export async function command(args: string[], env = process.env): Promise<string> {
    const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${err.trim()}`);
    return out;
}
