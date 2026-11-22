import { HANDOFF_CANCELLED, HANDOFF_DONE, HANDOFF_SKIPPED } from "../../../../extensions/builtin-browser/handoff.ts";
import type { BrowserHandoffState } from "../../../ui/src/browser/native-types.ts";
import { NO_WEB_PAGE_ERROR } from "./cdp.ts";
import type { BrowserPane } from "./pane.ts";

interface PendingHandoff {
    readonly state: BrowserHandoffState;
    readonly finish: (output: string) => void;
}

export class BrowserHandoff {
    private pending: PendingHandoff | undefined;

    constructor(private readonly pane: BrowserPane, private readonly changed: () => void) {}

    state(): BrowserHandoffState | undefined {
        return this.pending?.state;
    }

    start(id: string, reason: string): Promise<Record<string, unknown>> {
        const contents = this.pane.current();
        const page = this.pane.state().active;
        if (contents === undefined || contents.isDestroyed() || page === null) throw new Error(NO_WEB_PAGE_ERROR);
        return new Promise((resolve) => {
            const finish = (output: string): void => {
                if (this.pending?.state.id !== id) return;
                contents.removeListener("destroyed", destroyed);
                this.pending = undefined;
                this.changed();
                resolve({ output });
            };
            const destroyed = (): void => finish(HANDOFF_CANCELLED);
            this.pending = { state: { id, page, reason }, finish };
            contents.once("destroyed", destroyed);
            this.changed();
        });
    }

    complete(id: string, result: "done" | "skipped"): void {
        if (this.pending?.state.id !== id) return;
        this.pending.finish(result === "done" ? HANDOFF_DONE : HANDOFF_SKIPPED);
    }

    cancel(id?: string): void {
        if (this.pending !== undefined && (id === undefined || this.pending.state.id === id)) {
            this.pending.finish(HANDOFF_CANCELLED);
        }
    }
}
