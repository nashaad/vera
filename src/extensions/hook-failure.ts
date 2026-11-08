import type { HookFailureOptions } from "../sdk/hooks.ts";

export function validateHookFailureOptions(
    options: unknown,
    phase: string,
): HookFailureOptions["onFailure"] | undefined {
    if (options === undefined) return undefined;
    if (typeof options !== "object" || options === null || Array.isArray(options)
        || !("onFailure" in options)
        || (options.onFailure !== "allow" && options.onFailure !== "deny")) {
        throw new Error(`${phase} hook onFailure must be allow or deny`);
    }
    if (options.onFailure === "deny" && phase !== "pre_tool_use" && phase !== "pre_turn") {
        throw new Error(`${phase} hook cannot deny on failure because it cannot block`);
    }
    return options.onFailure;
}

export function rejectModelFailurePolicy(options: unknown, phase: string): void {
    if (options !== undefined) {
        throw new Error(`${phase} does not accept a failure policy because a failure there stops the request`);
    }
}

export function hookBlockReason(extensionId: string, phase: "pre_tool_use" | "pre_turn", failure: string): string {
    const action = phase === "pre_tool_use" ? "this tool call did not run" : "this prompt was not run";
    return `Extension ${extensionId}'s ${phase} hook failed (${failure}) and denies on failure, so ${action}.`;
}

export function hookFailure(error: unknown, command: boolean): string {
    let message: string;
    try {
        const detail = error instanceof Error ? error.message : error;
        message = typeof detail === "string" ? detail : String(detail);
    } catch {
        message = "unknown error";
    }
    if (command) {
        const timeout = /^Command hook timed out after (\d+)ms$/.exec(message);
        if (timeout !== null) return `timed out after ${timeout[1]}ms`;
        if (message === "Command hook returned invalid JSON") return "returned an invalid result";
    }
    const firstLine = message.split(/[\r\n\u0085\u2028\u2029]/, 1)[0]!.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
    return `threw: ${firstLine}`;
}

export function isHookJson(value: unknown, ancestors = new WeakSet<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    ancestors.add(value);
    let valid: boolean;
    if (Array.isArray(value)) {
        valid = [...value].every((item) => isHookJson(item, ancestors));
    } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        valid = (prototype === Object.prototype || prototype === null)
            && Object.getOwnPropertySymbols(value).length === 0
            && Object.values(value).every((item) => isHookJson(item, ancestors));
    }
    ancestors.delete(value);
    return valid;
}
