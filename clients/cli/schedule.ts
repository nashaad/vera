import type { ScheduleOperation } from "../../src/scheduler/types.ts";

interface Output {
    write(text: string): unknown;
}

export async function runScheduleCli(
    args: readonly string[],
    execute: (operation: ScheduleOperation) => Promise<Record<string, unknown>>,
    output: Output,
): Promise<number> {
    const operation = parseScheduleCli(args);
    if (operation === undefined) return 1;
    const result = await execute(operation);
    await Promise.resolve(output.write(`${JSON.stringify(result)}\n`));
    return 0;
}

export function parseScheduleCli(
    args: readonly string[],
): ScheduleOperation | undefined {
    const action = args[0];
    if (action === "list" && args.length === 1) return { action };
    if (
        action === "show"
        || action === "pause"
        || action === "resume"
        || action === "remove"
        || action === "run"
    ) {
        const id = args[1];
        return args.length === 2 && id !== undefined && id.length > 0
            ? { action, id }
            : undefined;
    }
    if (action !== "add") return undefined;
    const id = args[1];
    const flags = parseFlags(args.slice(2));
    if (id === undefined || id.length === 0 || flags === undefined) {
        return undefined;
    }
    const allowed = new Set(["--cron", "--timezone", "--to", "--text", "--payload"]);
    if ([...flags.keys()].some((flag) => !allowed.has(flag))) return undefined;
    const cron = flags.get("--cron");
    const address = flags.get("--to");
    const text = flags.get("--text");
    const rawPayload = flags.get("--payload");
    if (
        cron === undefined
        || address === undefined
        || (text === undefined) === (rawPayload === undefined)
    ) return undefined;
    let payload: Record<string, unknown>;
    if (text !== undefined) {
        payload = { text };
    } else {
        try {
            const parsed: unknown = JSON.parse(rawPayload!);
            if (!isRecord(parsed)) return undefined;
            payload = parsed;
        } catch {
            return undefined;
        }
    }
    return {
        action: "add",
        id,
        cron,
        timezone: flags.get("--timezone") ?? "UTC",
        address,
        payload,
    };
}

function parseFlags(args: readonly string[]): Map<string, string> | undefined {
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (
            flag === undefined
            || !flag.startsWith("--")
            || value === undefined
            || value.startsWith("--")
            || flags.has(flag)
        ) return undefined;
        flags.set(flag, value);
    }
    return flags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
