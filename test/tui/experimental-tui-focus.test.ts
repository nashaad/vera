import { expect, test } from "bun:test";

import {
    findTuiExperimentalFocusable,
    findTuiExperimentalModal,
    hasTuiExperimentalModal,
} from "../../clients/tui/experimental-tui-focus.ts";

interface Candidate {
    readonly id: string;
    readonly slot: "footer" | "overlay";
    readonly modal?: boolean;
    readonly focusable?: boolean;
    readonly visible: boolean;
}

const specFor = (candidate: Candidate) => candidate;
const visible = (candidate: Candidate) => candidate.visible;

test("experimental TUI focus selects visible modal and focusable candidates", () => {
    const candidates: Candidate[] = [
        { id: "hidden-modal", slot: "overlay", modal: true, visible: false },
        { id: "modal", slot: "overlay", modal: true, visible: true },
        { id: "focusable", slot: "footer", focusable: true, visible: true },
    ];
    expect(findTuiExperimentalModal(candidates, specFor, visible)?.id).toBe("modal");
    expect(findTuiExperimentalFocusable(candidates, specFor, visible)?.id)
        .toBe("focusable");
    expect(hasTuiExperimentalModal(candidates, specFor, visible)).toBe(true);
});
