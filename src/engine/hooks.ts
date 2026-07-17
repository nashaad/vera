import type {
    PostToolUseHook,
    PostToolUseHookPayload,
    PreToolUseHook,
    PreToolUseHookPayload,
    PreToolUseHookResult,
} from "../sdk/hooks.ts";

export interface HookCallOptions {
    readonly timeoutMs: number;
}

export class ToolHooks {
    private readonly preToolUse: PreToolUseHook[] = [];
    private readonly postToolUse: PostToolUseHook[] = [];

    registerPreToolUse(hook: PreToolUseHook): () => void {
        this.preToolUse.push(hook);
        return () => removeHook(this.preToolUse, hook);
    }

    registerPostToolUse(hook: PostToolUseHook): () => void {
        this.postToolUse.push(hook);
        return () => removeHook(this.postToolUse, hook);
    }

    async runPreToolUse(
        payload: PreToolUseHookPayload,
        options: HookCallOptions,
    ): Promise<PreToolUseHookResult> {
        const deadline = hookDeadline(options.timeoutMs);
        const safePayload = cloneHookData(payload);
        remainingTime(deadline, options.timeoutMs, payload.type);
        for (const hook of this.preToolUse) {
            const result = await callHook(
                async () => cloneHookData(await hook(cloneHookData(safePayload))),
                remainingTime(deadline, options.timeoutMs, payload.type),
                options.timeoutMs,
                payload.type,
            );
            remainingTime(deadline, options.timeoutMs, payload.type);
            if (result.behavior === "deny") {
                return result;
            }
        }
        return { behavior: "continue" };
    }

    async runPostToolUse(
        payload: PostToolUseHookPayload,
        options: HookCallOptions,
    ): Promise<void> {
        const deadline = hookDeadline(options.timeoutMs);
        const safePayload = cloneHookData(payload);
        remainingTime(deadline, options.timeoutMs, payload.type);
        for (const hook of this.postToolUse) {
            await callHook(
                () => hook(cloneHookData(safePayload)),
                remainingTime(deadline, options.timeoutMs, payload.type),
                options.timeoutMs,
                payload.type,
            );
            remainingTime(deadline, options.timeoutMs, payload.type);
        }
    }
}

function removeHook<Hook>(hooks: Hook[], hook: Hook): void {
    const index = hooks.indexOf(hook);
    if (index !== -1) {
        hooks.splice(index, 1);
    }
}

async function callHook<Result>(
    call: () => Result | Promise<Result>,
    timeoutMs: number,
    budgetMs: number,
    type: string,
): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${type} hooks timed out after ${budgetMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            Promise.resolve().then(call),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function hookDeadline(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Hook timeout must be a positive finite number");
    }
    return performance.now() + timeoutMs;
}

function remainingTime(
    deadline: number,
    budgetMs: number,
    type: string,
): number {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
        throw new Error(`${type} hooks timed out after ${budgetMs}ms`);
    }
    return remaining;
}

function cloneHookData<Value>(value: Value): Value {
    assertJsonValue(value, "$", new WeakSet());
    return JSON.parse(JSON.stringify(value)) as Value;
}

function assertJsonValue(
    value: unknown,
    path: string,
    ancestors: WeakSet<object>,
): void {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return;
    }
    if (typeof value === "number") {
        if (Number.isFinite(value)) {
            return;
        }
        throw new Error(`Hook data at ${path} must contain a finite number`);
    }
    if (typeof value !== "object") {
        throw new Error(`Hook data at ${path} is not JSON-serializable`);
    }
    if (ancestors.has(value)) {
        throw new Error(`Hook data at ${path} contains a cycle`);
    }

    ancestors.add(value);
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            assertJsonValue(item, `${path}[${index}]`, ancestors);
        }
    } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`Hook data at ${path} must contain a plain object`);
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new Error(`Hook data at ${path} cannot contain symbol keys`);
        }
        for (const [key, item] of Object.entries(value)) {
            assertJsonValue(item, `${path}.${key}`, ancestors);
        }
    }
    ancestors.delete(value);
}
