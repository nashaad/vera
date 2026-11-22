// The `vera` handles an extension receives. The window checks everything again, so a refusal here is
// feedback for the extension's author, not the boundary. The API is unstable: names and shapes may change.

import {
    isLevel,
    isTone,
    MAX_KEY_CHARS,
    MAX_LOG_CHARS,
    MAX_TOAST_CHARS,
    MAX_VALUE_CHARS,
    type ContextValue,
    type FromWorker,
    type PlainData,
    type ToastTone,
} from "../envelope.ts";
import { ownsContextKey } from "../context.ts";
import type { ExtensionLogLevel } from "../../protocol/desktop-extensions.ts";

export type Handler = (args?: PlainData) => unknown;

export function createVera(extensionId: string, declared: ReadonlySet<string>, handlers: Map<string, Handler>, send: (message: FromWorker) => void) {
    return Object.freeze({
        commands: Object.freeze({
            register(id: string, handler: Handler): void {
                if (!declared.has(id)) throw new Error(`Command "${id}" is not declared in the manifest.`);
                if (typeof handler !== "function") throw new TypeError("A command handler must be a function.");
                handlers.set(id, handler);
            },
        }),
        window: Object.freeze({
            showToast(text: string, tone?: ToastTone): void {
                if (typeof text !== "string" || text.length > MAX_TOAST_CHARS) throw new RangeError(`A toast takes text up to ${MAX_TOAST_CHARS} characters.`);
                if (tone !== undefined && !isTone(tone)) throw new TypeError("A toast tone is info, success, warning or danger.");
                send(tone === undefined ? { type: "toast", text } : { type: "toast", text, tone });
            },
        }),
        output: Object.freeze({
            appendLine(text: string, level: ExtensionLogLevel = "info"): void {
                if (typeof text !== "string" || text.length > MAX_LOG_CHARS) throw new RangeError(`An output line takes text up to ${MAX_LOG_CHARS} characters.`);
                if (!isLevel(level)) throw new TypeError("An output level is info, warn or error.");
                send({ type: "log", level, text });
            },
        }),
        context: Object.freeze({
            set(key: string, value?: ContextValue | null): void {
                if (typeof key !== "string" || key.length > MAX_KEY_CHARS || !ownsContextKey(extensionId, key)) {
                    throw new Error(`A context key must start with "${extensionId}.".`);
                }
                if (value === undefined || value === null) {
                    send({ type: "context", key });
                    return;
                }
                const valid = typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
                    || (typeof value === "string" && value.length <= MAX_VALUE_CHARS);
                if (!valid) throw new TypeError(`A context value is a boolean, a number or text up to ${MAX_VALUE_CHARS} characters.`);
                send({ type: "context", key, value });
            },
        }),
    });
}
