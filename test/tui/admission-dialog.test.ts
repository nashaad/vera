import { expect, test } from "bun:test";

import {
    handleTuiAdmissionDialogKey,
    startTuiAdmissionDialog,
    tuiAdmissionDialogPhase,
} from "../../clients/tui/admission-dialog.ts";
import type { TuiAdmissionState } from "../../clients/tui/state.ts";

const running: TuiAdmissionState = {
    requestId: "pool-1",
    subject: "or/glm",
    steps: [{ step: "reach", label: "endpoint reachable", status: "running" }],
};

test("the dialog opens on a run already under way", () => {
    // There is nothing to confirm: the probes are on the wire before the
    // dialog exists, so the first phase is the running one.
    const dialog = startTuiAdmissionDialog("or", "glm", "pool-1");

    expect(tuiAdmissionDialogPhase(dialog, undefined)).toBe("running");
    expect(handleTuiAdmissionDialogKey(dialog, undefined, { name: "escape" }))
        .toBe("hide");
    expect(handleTuiAdmissionDialogKey(dialog, undefined, { name: "return" }))
        .toBeUndefined();
});

test("a running admission cannot be aborted, only hidden", () => {
    // There is no abort wire for pool_add, so esc hides the dialog and the
    // transcript notice carries the run to its verdict.
    const dialog = startTuiAdmissionDialog("or", "glm", "pool-1");

    expect(tuiAdmissionDialogPhase(dialog, running)).toBe("running");
    expect(handleTuiAdmissionDialogKey(dialog, running, { name: "escape" }))
        .toBe("hide");
    expect(handleTuiAdmissionDialogKey(dialog, running, { name: "return" }))
        .toBeUndefined();
});

test("the verdict decides what enter does", () => {
    const dialog = startTuiAdmissionDialog("or", "glm", "pool-1");
    const added: TuiAdmissionState = { ...running, verdict: "added" };
    const unavailable: TuiAdmissionState = {
        ...running,
        verdict: "unavailable",
    };

    expect(tuiAdmissionDialogPhase(dialog, added)).toBe("done");
    expect(handleTuiAdmissionDialogKey(dialog, added, { name: "return" }))
        .toBe("dismiss");
    expect(handleTuiAdmissionDialogKey(dialog, added, { name: "escape" }))
        .toBe("dismiss");
    // Unavailable invites another try on the same key that started the first.
    expect(handleTuiAdmissionDialogKey(dialog, unavailable, { name: "return" }))
        .toBe("retry");
    expect(handleTuiAdmissionDialogKey(dialog, unavailable, { name: "escape" }))
        .toBe("dismiss");
});

test("an admission for another request keeps the dialog in running", () => {
    // A stale record (say, a previous retry) must not end this run early.
    const dialog = startTuiAdmissionDialog("or", "glm", "pool-2");
    const stale: TuiAdmissionState = { ...running, verdict: "added" };

    expect(tuiAdmissionDialogPhase(dialog, stale)).toBe("running");
});
