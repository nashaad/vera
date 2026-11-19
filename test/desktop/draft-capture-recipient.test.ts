import { describe, expect, test } from "bun:test";
import { DraftCaptureRecipient } from "../../clients/ui/src/composer/draft-capture-recipient.ts";
import type { PageCapture } from "../../clients/ui/src/composer/page-captures.ts";

function capture(path: string): PageCapture {
    return { path, preview: path, text: path };
}

describe("draft capture recipient", () => {
    test("holds late captures until handoff and routes future captures to the created session", () => {
        const recipient = new DraftCaptureRecipient();
        const draft: string[] = [];
        const sessions: string[] = [];
        recipient.subscribe((item) => draft.push(item.path));
        recipient.capture(capture("first"));
        recipient.begin(1);
        recipient.capture(capture("late"));
        recipient.created("created", (id, item) => sessions.push(`${id}:${item.path}`));
        recipient.capture(capture("later"));
        expect(draft).toEqual(["first"]);
        expect(sessions).toEqual([]);
        recipient.complete();
        recipient.capture(capture("future"));
        recipient.complete();
        expect(sessions).toEqual(["created:late", "created:later", "created:future"]);
    });

    test("returns late captures to the same draft after creation failure", () => {
        const recipient = new DraftCaptureRecipient();
        const draft: string[] = [];
        recipient.subscribe((item) => draft.push(item.path));
        recipient.begin(6);
        expect(recipient.capture(capture("one"))).toBe(true);
        expect(recipient.capture(capture("two"))).toBe(true);
        expect(recipient.capture(capture("overflow"))).toBe(false);
        recipient.failed();
        expect(draft).toEqual(["one", "two"]);
        recipient.begin(8);
        expect(recipient.capture(capture("full"))).toBe(false);
    });

    test("shares one bounded waiting budget across handoffs", () => {
        const first = new DraftCaptureRecipient();
        const second = new DraftCaptureRecipient();
        first.begin(0);
        second.begin(0);
        for (let index = 0; index < 8; index++) expect(first.capture(capture(String(index)))).toBe(true);
        expect(second.capture(capture("overflow"))).toBe(false);
        first.created("session", () => {});
        first.complete();
        expect(second.capture(capture("available"))).toBe(true);
        second.subscribe(() => {});
        second.failed();
    });

    test("holds bounded captures before the draft subscribes", () => {
        const recipient = new DraftCaptureRecipient();
        for (let index = 0; index < 8; index++) expect(recipient.capture(capture(String(index)))).toBe(true);
        expect(recipient.capture(capture("overflow"))).toBe(false);
        const draft: string[] = [];
        recipient.subscribe((item) => draft.push(item.path));
        expect(draft).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    });
});
