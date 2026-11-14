import { beforeEach, describe, expect, test } from "bun:test";

import { sendSessionMode } from "../../clients/ui/src/composer/requests.ts";
import { autoNudgeShown, autoNudgeTarget, forgetAutoNudges, markAutoNudgeShown } from "../../clients/ui/src/session/autoNudge.ts";
import type { ApprovalRequest, OpenRequest } from "../../clients/ui/src/session/requests.ts";

const approval: ApprovalRequest = {
    kind: "approval",
    requestId: "r1",
    tool: "bash",
    input: { command: "ls" },
    reason: "",
    warning: "",
    grants: [],
    grantPredicates: [],
};

const question: OpenRequest = {
    kind: "question",
    requestId: "q1",
    question: "Which nest?",
    choices: [],
    allowCustom: true,
    allowNotes: false,
    outOfBand: false,
};

describe("auto suggestion", () => {
    beforeEach(forgetAutoNudges);

    test("@core the line sits under the first approval only while the host suggests it and this window has not shown it", () => {
        expect(autoNudgeTarget(approval, true, false)).toBe("r1");
        expect(autoNudgeTarget(approval, false, false)).toBeUndefined();
        expect(autoNudgeTarget(approval, true, true)).toBeUndefined();
        expect(autoNudgeTarget(question, true, false)).toBeUndefined();
        expect(autoNudgeTarget(undefined, true, false)).toBeUndefined();
    });

    test("Switch sends the same session mode command as the approval pill", () => {
        const sent: string[] = [];
        const requestId = sendSessionMode((line) => sent.push(line), "auto");
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0]!)).toEqual({ type: "update_session_permission_mode", requestId, mode: "auto" });
        expect(requestId.startsWith("desktop-mode-")).toBe(true);
    });

    test("a session is remembered once the line was shown, and the memory is capped", () => {
        expect(autoNudgeShown("a1")).toBe(false);
        markAutoNudgeShown("a1");
        expect(autoNudgeShown("a1")).toBe(true);
        expect(autoNudgeShown("a2")).toBe(false);

        for (let index = 0; index < 250; index += 1) markAutoNudgeShown(`s${index}`);
        expect(autoNudgeShown("a1")).toBe(false);
        expect(autoNudgeShown("s249")).toBe(true);
    });
});
