import { IMAGE_LIMIT } from "./images.ts";

import type { PageCapture } from "../protocol/page-captures.ts";
export type { PageCapture, PageCaptureDetails } from "../protocol/page-captures.ts";

export type PageCaptureListener = (capture: PageCapture) => void;

export function appendPageCaptureText(text: string, captures: readonly PageCapture[]): string {
    const blocks = captures.map((capture) => capture.text).filter((value) => value.length > 0);
    if (blocks.length === 0) return text;
    const captureText = blocks.join("\n\n");
    return text.length === 0 ? captureText : `${text}\n\n${captureText}`;
}

const waiting = new Map<string, PageCapture[]>();
const listeners = new Map<string, Set<PageCaptureListener>>();
let waitingCount = 0;

export function queuePageCapture(sessionId: string, capture: PageCapture): void {
    if (sessionId.length === 0) return;
    const subscribers = listeners.get(sessionId);
    const recipient = subscribers?.values().next().value;
    if (recipient !== undefined) {
        recipient(capture);
        return;
    }
    const captures = waiting.get(sessionId) ?? [];
    if (captures.length >= IMAGE_LIMIT || waitingCount >= IMAGE_LIMIT) return;
    captures.push(capture);
    waiting.set(sessionId, captures);
    waitingCount += 1;
}

export function subscribePageCaptures(sessionId: string, listener: PageCaptureListener): () => void {
    const subscribers = listeners.get(sessionId) ?? new Set<PageCaptureListener>();
    const isFirst = subscribers.size === 0;
    subscribers.add(listener);
    listeners.set(sessionId, subscribers);
    if (isFirst) {
        const captures = waiting.get(sessionId) ?? [];
        for (const capture of captures) listener(capture);
        waitingCount -= captures.length;
        waiting.delete(sessionId);
    }
    return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(sessionId);
    };
}

export function clearPageCapturesForTest(): void {
    waiting.clear();
    listeners.clear();
    waitingCount = 0;
}
