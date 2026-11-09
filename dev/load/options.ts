import { parseArgs } from "node:util";
import type { Scenario } from "./results.ts";

export interface LoadOptions {
    readonly scenario: Scenario;
    readonly matrix: boolean;
    readonly check: boolean;
    readonly cpuProfile: boolean;
}

export function parseLoadOptions(args: string[]): LoadOptions {
    const { values } = parseArgs({ args, options: {
        sessions: { type: "string", default: "8" }, clients: { type: "string", default: "1" }, duration: { type: "string", default: "120" },
        seed: { type: "string", default: "1" }, extensions: { type: "string", default: "included" },
        workers: { type: "string" },
        matrix: { type: "boolean" }, check: { type: "boolean" }, "small-fixture": { type: "boolean" }, paging: { type: "boolean" }, "cpu-profile": { type: "boolean" },
        "pin-worker": { type: "boolean" }, "kill-worker": { type: "boolean" }, relay: { type: "boolean" },
    }, strict: true });
    const number = (value: string, name: string) => {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
        return parsed;
    };
    if (values.extensions !== "included" && values.extensions !== "none") throw new Error("--extensions must be included or none");
    const workers = values.workers === undefined ? undefined : Number(values.workers);
    if (workers !== undefined && (!Number.isSafeInteger(workers) || workers < 0 || values.workers!.trim() === "")) {
        throw new Error("workers must be a non-negative integer");
    }
    if (workers === 0 && (values["pin-worker"] || values["kill-worker"])) throw new Error("A worker experiment requires session processes");
    if (values["pin-worker"] && values["kill-worker"]) throw new Error("Choose one worker experiment");
    const scenario: Scenario = {
        sessions: number(values.sessions!, "sessions"), clients: number(values.clients!, "clients"), duration: number(values.duration!, "duration"),
        seed: number(values.seed!, "seed"), extensions: values.extensions, small: values["small-fixture"] ?? false,
        paging: values.paging ?? false, relay: values.relay ?? false,
        ...(workers === undefined ? {} : { workers }), ...(values["pin-worker"] ? { pinWorker: true } : {}),
        ...(values["kill-worker"] ? { killWorker: true } : {}),
    };
    return { scenario, matrix: values.matrix ?? false, check: values.check ?? false, cpuProfile: values["cpu-profile"] ?? false };
}
