import type {
    HookToolCall,
    HookToolResult,
    PostToolUseHook,
    PostToolUseHookPayload,
    PostToolUseHookResult,
    PreToolUseHook,
    PreToolUseHookPayload,
    PreToolUseHookResult,
    PreTurnHook,
    PreTurnHookPayload,
    PreTurnHookResult,
} from "../sdk/hooks.ts";

export interface HookCallOptions {
    readonly timeoutMs: number;
}

export interface PreToolUseOutcome {
    readonly toolCall: HookToolCall;
    readonly result: PreToolUseHookResult;
}

export interface PreTurnOutcome {
    readonly payload: PreTurnHookPayload;
    readonly result: PreTurnHookResult;
}

export class ToolHooks {
    private readonly preToolUse: PreToolUseHook[] = [];
    private readonly postToolUse: PostToolUseHook[] = [];
    private readonly preTurn: PreTurnHook[] = [];

    registerPreToolUse(hook: PreToolUseHook): () => void {
        this.preToolUse.push(hook);
        return () => removeHook(this.preToolUse, hook);
    }

    registerPostToolUse(hook: PostToolUseHook): () => void {
        this.postToolUse.push(hook);
        return () => removeHook(this.postToolUse, hook);
    }

    registerPreTurn(hook: PreTurnHook): () => void {
        this.preTurn.push(hook);
        return () => removeHook(this.preTurn, hook);
    }

    async runPreToolUse(
        payload: PreToolUseHookPayload,
        options: HookCallOptions,
    ): Promise<PreToolUseOutcome> {
        const deadline = hookDeadline(options.timeoutMs);
        let currentPayload = cloneHookData(payload);
        let currentResult: PreToolUseHookResult = { power: "observe" };
        remainingTime(deadline, options.timeoutMs, payload.type);
        for (const hook of this.preToolUse) {
            const result = await callHook(
                async () => cloneHookData(
                    await hook(cloneHookData(currentPayload)),
                ),
                remainingTime(deadline, options.timeoutMs, payload.type),
                options.timeoutMs,
                payload.type,
            );
            assertPreToolUseHookResult(result);
            remainingTime(deadline, options.timeoutMs, payload.type);
            if (result.power === "mutate") {
                currentPayload = {
                    ...currentPayload,
                    toolCall: {
                        ...currentPayload.toolCall,
                        input: cloneHookData(result.input),
                    },
                };
                currentResult = {
                    power: "mutate",
                    input: cloneHookData(result.input),
                };
                continue;
            }
            if (result.power === "block" || result.power === "replace") {
                return {
                    toolCall: currentPayload.toolCall,
                    result,
                };
            }
        }
        return {
            toolCall: currentPayload.toolCall,
            result: currentResult,
        };
    }

    async runPostToolUse(
        payload: PostToolUseHookPayload,
        options: HookCallOptions,
    ): Promise<HookToolResult> {
        const deadline = hookDeadline(options.timeoutMs);
        let currentPayload = cloneHookData(payload);
        remainingTime(deadline, options.timeoutMs, payload.type);
        for (const hook of this.postToolUse) {
            const result: PostToolUseHookResult = await callHook(
                async () => cloneHookData(
                    await hook(cloneHookData(currentPayload)),
                ),
                remainingTime(deadline, options.timeoutMs, payload.type),
                options.timeoutMs,
                payload.type,
            );
            assertPostToolUseHookResult(result);
            remainingTime(deadline, options.timeoutMs, payload.type);
            if (result.power === "mutate") {
                currentPayload = {
                    ...currentPayload,
                    result: {
                        ...currentPayload.result,
                        ...(result.patch.content === undefined
                            ? {}
                            : { content: cloneHookData(result.patch.content) }),
                        ...(result.patch.isError === undefined
                            ? {}
                            : { isError: result.patch.isError }),
                    },
                };
            }
        }
        return currentPayload.result;
    }

    async runPreTurn(
        payload: PreTurnHookPayload,
        options: HookCallOptions,
    ): Promise<PreTurnOutcome> {
        const deadline = hookDeadline(options.timeoutMs);
        let currentPayload = cloneHookData(payload);
        let currentResult: PreTurnHookResult = { power: "observe" };
        remainingTime(deadline, options.timeoutMs, payload.type);
        for (const hook of this.preTurn) {
            const result = await callHook(
                async () => cloneHookData(
                    await hook(cloneHookData(currentPayload)),
                ),
                remainingTime(deadline, options.timeoutMs, payload.type),
                options.timeoutMs,
                payload.type,
            );
            assertPreTurnHookResult(result);
            remainingTime(deadline, options.timeoutMs, payload.type);
            if (result.power === "mutate") {
                currentPayload = applyPreTurnMutate(currentPayload, result);
                currentResult = {
                    power: "mutate",
                    ...(result.tools === undefined
                        ? {}
                        : { tools: [...result.tools] }),
                    ...(result.model === undefined ? {} : { model: result.model }),
                    ...(result.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: result.reasoningEffort }),
                };
                continue;
            }
            if (result.power === "block") {
                return {
                    payload: currentPayload,
                    result,
                };
            }
        }
        return {
            payload: currentPayload,
            result: currentResult,
        };
    }
}

function applyPreTurnMutate(
    payload: PreTurnHookPayload,
    result: Extract<PreTurnHookResult, { power: "mutate" }>,
): PreTurnHookPayload {
    const tools = result.tools === undefined
        ? payload.tools
        : restrictOfferedToolNames(payload.tools, result.tools);
    return {
        ...payload,
        tools,
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: result.reasoningEffort }),
    };
}

/**
 * A named subset keeps only tools this turn already offered. An empty list
 * is an explicit "none". Names that were never offered are dropped; if that
 * leaves nothing from a non-empty request, the offer is unchanged.
 */
export function restrictOfferedToolNames(
    offered: readonly string[],
    requested: readonly string[],
): readonly string[] {
    if (requested.length === 0) {
        return [];
    }
    const allowed = new Set(offered);
    const kept = requested.filter((name) => allowed.has(name));
    if (kept.length === 0) {
        return offered;
    }
    if (kept.includes("bash") && offered.includes("process")) {
        return kept.includes("process") ? kept : [...kept, "process"];
    }
    return kept;
}

function assertPreToolUseHookResult(
    result: unknown,
): asserts result is PreToolUseHookResult {
    assertHookResultObject(result, "pre_tool_use");
    if (result.power === "observe") {
        return;
    }
    if (result.power === "mutate") {
        assertPlainObject(result.input, "pre_tool_use mutate input");
        return;
    }
    if (result.power === "block") {
        if (typeof result.reason !== "string" || result.reason.length === 0) {
            throw new Error("pre_tool_use block reason must be a non-empty string");
        }
        return;
    }
    if (result.power === "replace") {
        assertToolResultValue(result.result, "pre_tool_use replacement");
        return;
    }
    throw new Error(`pre_tool_use returned unsupported power: ${String(result.power)}`);
}

function assertPostToolUseHookResult(
    result: unknown,
): asserts result is PostToolUseHookResult {
    assertHookResultObject(result, "post_tool_use");
    if (result.power === "observe") {
        return;
    }
    if (result.power !== "mutate") {
        throw new Error(`post_tool_use returned unsupported power: ${String(result.power)}`);
    }
    assertPlainObject(result.patch, "post_tool_use mutate patch");
    if (result.patch.content !== undefined) {
        assertTextContent(result.patch.content, "post_tool_use mutate patch content");
    }
    if (
        result.patch.isError !== undefined
        && typeof result.patch.isError !== "boolean"
    ) {
        throw new Error("post_tool_use mutate patch isError must be a boolean");
    }
}

function assertPreTurnHookResult(
    result: unknown,
): asserts result is PreTurnHookResult {
    assertHookResultObject(result, "pre_turn");
    if (result.power === "observe") {
        return;
    }
    if (result.power === "block") {
        if (typeof result.reason !== "string" || result.reason.length === 0) {
            throw new Error("pre_turn block reason must be a non-empty string");
        }
        return;
    }
    if (result.power !== "mutate") {
        throw new Error(`pre_turn returned unsupported power: ${String(result.power)}`);
    }
    if (result.tools !== undefined) {
        if (
            !Array.isArray(result.tools)
            || result.tools.some((name) => typeof name !== "string" || name.length === 0)
        ) {
            throw new Error("pre_turn mutate tools must be an array of non-empty strings");
        }
    }
    if (result.model !== undefined) {
        if (typeof result.model !== "string" || result.model.length === 0) {
            throw new Error("pre_turn mutate model must be a non-empty string");
        }
    }
    if (result.reasoningEffort !== undefined) {
        if (
            typeof result.reasoningEffort !== "string"
            || result.reasoningEffort.length === 0
        ) {
            throw new Error(
                "pre_turn mutate reasoningEffort must be a non-empty string",
            );
        }
    }
}

function assertHookResultObject(
    result: unknown,
    hookType: string,
): asserts result is Record<string, unknown> {
    assertPlainObject(result, `${hookType} result`);
    if (typeof result.power !== "string") {
        throw new Error(`${hookType} result power must be a string`);
    }
}

function assertToolResultValue(value: unknown, label: string): void {
    assertPlainObject(value, label);
    assertTextContent(value.content, `${label} content`);
    if (typeof value.isError !== "boolean") {
        throw new Error(`${label} isError must be a boolean`);
    }
}

function assertTextContent(value: unknown, label: string): void {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    for (const item of value) {
        assertPlainObject(item, `${label} item`);
        if (item.type !== "text" || typeof item.text !== "string") {
            throw new Error(`${label} items must be text content`);
        }
    }
}

function assertPlainObject(
    value: unknown,
    label: string,
): asserts value is Record<string, unknown> {
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null)
    ) {
        throw new Error(`${label} must be a plain object`);
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
