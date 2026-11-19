import { describe, expect, test } from "bun:test";

import {
    appendPageCaptureText,
    queuePageCapture,
    subscribePageCaptures,
    type PageCapture,
} from "../../clients/ui/src/composer/page-captures.ts";
import { IMAGE_LIMIT } from "../../clients/ui/src/composer/images.ts";

function capture(path: string, text = "Selected in the Browser tab on https://example.test"): PageCapture {
    return { path, preview: `data:image/png;base64,${path}`, text };
}

describe("page capture composer handoff", () => {
    test("delivers only to a subscriber for the owning session", () => {
        const first: PageCapture[] = [];
        const second: PageCapture[] = [];
        const stopFirst = subscribePageCaptures("capture-session-a", (item) => first.push(item));
        const stopSecond = subscribePageCaptures("capture-session-b", (item) => second.push(item));

        queuePageCapture("capture-session-a", capture("/tmp/a.png"));

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(0);
        stopFirst();
        stopSecond();
    });

    test("delivers to one listener and hands delivery to the next after unsubscribe", () => {
        const first: PageCapture[] = [];
        const second: PageCapture[] = [];
        const stopFirst = subscribePageCaptures("capture-session-shared", (item) => first.push(item));
        const stopSecond = subscribePageCaptures("capture-session-shared", (item) => second.push(item));

        queuePageCapture("capture-session-shared", capture("/tmp/first.png"));
        stopFirst();
        queuePageCapture("capture-session-shared", capture("/tmp/second.png"));

        expect(first.map((item) => item.path)).toEqual(["/tmp/first.png"]);
        expect(second.map((item) => item.path)).toEqual(["/tmp/second.png"]);
        stopSecond();
    });

    test("queues at most IMAGE_LIMIT captures until the composer subscribes", () => {
        for (let index = 0; index < IMAGE_LIMIT + 2; index += 1) {
            queuePageCapture("capture-session-limit", capture(`/tmp/${index}.png`));
        }
        const received: PageCapture[] = [];
        const stop = subscribePageCaptures("capture-session-limit", (item) => received.push(item));

        expect(received).toHaveLength(IMAGE_LIMIT);
        stop();
    });

    test("appends capture text after a blank line without changing the base text", () => {
        const block = "Selected in the Browser tab on https://example.test\nElement: p";
        const item = capture("/tmp/page.png", block);

        expect(appendPageCaptureText("Check this", [item])).toBe(`Check this\n\n${block}`);
        expect(appendPageCaptureText("", [item])).toBe(block);
        expect(appendPageCaptureText("Check this", [])).toBe("Check this");
    });
});
