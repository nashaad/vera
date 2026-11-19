import { IMAGE_LIMIT } from "./images.ts";
import type { PageCapture, PageCaptureListener } from "./page-captures.ts";

let waitingTotal = 0;

export class DraftCaptureRecipient {
    private phase: "draft" | "creating" | "handoff" | "session" = "draft";
    private draftListener: PageCaptureListener | undefined;
    private sessionListener: ((agentId: string, capture: PageCapture) => void) | undefined;
    private agentId: string | undefined;
    private waiting: PageCapture[] = [];
    private waitingLimit = IMAGE_LIMIT;

    isDraft(): boolean {
        return this.phase === "draft";
    }

    subscribe(listener: PageCaptureListener): () => void {
        this.draftListener = listener;
        if (this.phase === "draft") this.flushDraft();
        return () => {
            if (this.draftListener === listener) this.draftListener = undefined;
        };
    }

    capture(capture: PageCapture): boolean {
        if (this.phase === "session" && this.agentId !== undefined && this.sessionListener !== undefined) {
            this.sessionListener(this.agentId, capture);
            return true;
        }
        if (this.phase === "draft" && this.draftListener !== undefined) {
            this.draftListener(capture);
            return true;
        }
        if (this.waiting.length >= this.waitingLimit || waitingTotal >= IMAGE_LIMIT) return false;
        this.waiting.push(capture);
        waitingTotal += 1;
        return true;
    }

    begin(attachmentCount: number): void {
        if (this.phase !== "draft") return;
        this.phase = "creating";
        this.waitingLimit = Math.max(0, IMAGE_LIMIT - attachmentCount);
    }

    failed(): void {
        if (this.phase !== "creating") return;
        this.phase = "draft";
        this.waitingLimit = IMAGE_LIMIT;
        this.flushDraft();
    }

    created(agentId: string, deliver: (agentId: string, capture: PageCapture) => void): void {
        if (this.phase !== "creating") return;
        this.agentId = agentId;
        this.sessionListener = deliver;
        this.phase = "handoff";
    }

    complete(): void {
        if (this.phase !== "handoff" || this.agentId === undefined || this.sessionListener === undefined) return;
        this.phase = "session";
        const waiting = this.waiting;
        this.waiting = [];
        waitingTotal -= waiting.length;
        for (const capture of waiting) this.sessionListener(this.agentId, capture);
    }

    private flushDraft(): void {
        if (this.draftListener === undefined) return;
        const waiting = this.waiting;
        this.waiting = [];
        waitingTotal -= waiting.length;
        for (const capture of waiting) this.draftListener(capture);
    }
}
