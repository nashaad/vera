import { expect, test } from "bun:test";
import { addOwnerCapture, beginOwnerCreate, closeOwnerCommand, draftCaptureOwner, failOwnerCreate, observeCreatingDraft, setOwnerCaptureCount, startDraftCaptureOwner, transferOwner } from "../../clients/ui/src/composer/draft-capture-owner.ts";
import type { PageCapture } from "../../clients/ui/src/composer/page-captures.ts";

const capture: PageCapture = { path: "/capture.png", preview: "preview", text: "selection" };

test("a command started during create joins that create before it receives captures", () => {
    let joined = false;
    const stop = observeCreatingDraft((owner) => {
        joined = true;
        beginOwnerCreate(owner, 8);
    });
    const owner = startDraftCaptureOwner(undefined);
    expect(joined).toBe(true);
    expect(addOwnerCapture(owner, capture)).toBe(false);
    stop();
    failOwnerCreate(owner);
    closeOwnerCommand(owner);
    expect(draftCaptureOwner()).toBeUndefined();
});

test("closing a command retains its unsent draft until its capture is removed", () => {
    const owner = startDraftCaptureOwner("/folder");
    expect(addOwnerCapture(owner, capture)).toBe(true);
    closeOwnerCommand(owner);
    expect(draftCaptureOwner()).toBe(owner);
    expect(startDraftCaptureOwner(undefined)).toBe(owner);
    owner.recipient.subscribe(() => {});
    closeOwnerCommand(owner);
    setOwnerCaptureCount(owner, 0);
    expect(draftCaptureOwner()).toBeUndefined();
});

test("creation failure retains captures, transfer releases the draft owner", () => {
    const owner = startDraftCaptureOwner(undefined);
    const restored: PageCapture[] = [];
    owner.recipient.subscribe((item) => restored.push(item));
    beginOwnerCreate(owner, 1);
    addOwnerCapture(owner, capture);
    closeOwnerCommand(owner);
    failOwnerCreate(owner);
    expect(restored).toEqual([capture]);
    expect(draftCaptureOwner()).toBe(owner);
    transferOwner(owner);
    expect(draftCaptureOwner()).toBeUndefined();
});
