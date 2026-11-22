import type { WorkerInitializationRenderOptions } from "@pierre/diffs/worker";
import { VERA_DIFF_THEME } from "./pierreTheme.ts";

const WORKER_URL = "./worker.js";

export const DIFF_HIGHLIGHTER_OPTIONS = {
    theme: VERA_DIFF_THEME,
    preferredHighlighter: "shiki-js",
    tokenizeMaxLineLength: 1000,
    maxLineDiffLength: 512,
} satisfies WorkerInitializationRenderOptions;

export const DIFF_POOL_OPTIONS = {
    workerFactory: (): Worker => new Worker(new URL(WORKER_URL, import.meta.url), { type: "module" }),
    poolSize: 2,
};

export function diffWorkerUrl(): URL {
    return new URL(WORKER_URL, import.meta.url);
}
