import { DraftCaptureRecipient } from "./draft-capture-recipient.ts";
import type { PageCapture } from "./page-captures.ts";

export interface DraftCaptureOwner {
    readonly recipient: DraftCaptureRecipient;
    readonly folder: string | undefined;
    commands: number;
    captures: number;
    creating: boolean;
}

let current: DraftCaptureOwner | undefined;
let creatingObserver: ((owner: DraftCaptureOwner) => void) | undefined;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

export function draftCaptureOwner(): DraftCaptureOwner | undefined {
    return current;
}

export function subscribeDraftCaptureOwner(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function observeCreatingDraft(observer: (owner: DraftCaptureOwner) => void): () => void {
    creatingObserver = observer;
    return () => { if (creatingObserver === observer) creatingObserver = undefined; };
}

export function startDraftCaptureOwner(folder: string | undefined): DraftCaptureOwner {
    if (current === undefined) {
        current = { recipient: new DraftCaptureRecipient(), folder, commands: 0, captures: 0, creating: false };
        creatingObserver?.(current);
        notify();
    }
    current.commands += 1;
    return current;
}

export function addOwnerCapture(owner: DraftCaptureOwner, capture: PageCapture): boolean {
    owner.captures += 1;
    if (owner.recipient.capture(capture)) return true;
    owner.captures -= 1;
    return false;
}

export function setOwnerCaptureCount(owner: DraftCaptureOwner, count: number): void {
    owner.captures = count;
    discardIfUnused(owner);
}

export function closeOwnerCommand(owner: DraftCaptureOwner): void {
    owner.commands = Math.max(0, owner.commands - 1);
    discardIfUnused(owner);
}

export function beginOwnerCreate(owner: DraftCaptureOwner, attachmentCount: number): void {
    owner.creating = true;
    owner.recipient.begin(attachmentCount);
}

export function failOwnerCreate(owner: DraftCaptureOwner): void {
    owner.creating = false;
    owner.recipient.failed();
    discardIfUnused(owner);
}

export function transferOwner(owner: DraftCaptureOwner): void {
    if (current !== owner) return;
    current = undefined;
    notify();
}

function discardIfUnused(owner: DraftCaptureOwner): void {
    if (current === owner && owner.commands === 0 && owner.captures === 0 && !owner.creating) {
        current = undefined;
        notify();
    }
}
