import type { Block, SessionWatch } from "./model.ts";
import { canStart } from "./liveSession.ts";

export interface SessionEvidence {
    readonly review: boolean;
    readonly plan: boolean;
    readonly files: boolean;
    readonly context: boolean;
}

export const NO_SESSION_EVIDENCE: SessionEvidence = { review: false, plan: false, files: false, context: false };

interface BlockMarks {
    readonly diff: boolean;
    readonly checklist: boolean;
}

// Blocks are replaced, never edited, so a block's marks hold for as long as the block does.
const marks = new WeakMap<Block, BlockMarks>();

function marksOf(block: Block): BlockMarks {
    const known = marks.get(block);
    if (known !== undefined) return known;
    let diff = false;
    let checklist = false;
    if (block.kind === "tools") {
        for (const call of block.calls) {
            if (call.presentation?.kind === "diff") diff = true;
            if (call.presentation?.kind === "checklist") checklist = true;
        }
    }
    const result = { diff, checklist };
    marks.set(block, result);
    return result;
}

export interface SessionPlace {
    // The session's own folder; a chat's files folder does not count.
    readonly folder: string | undefined;
    readonly chat: boolean;
}

// What the open session has had so far: every field in `seen` stays on, and the transcript is
// scanned only while changes or a checklist are still missing.
export function readSessionEvidence(watch: SessionWatch, place: SessionPlace, seen: SessionEvidence): SessionEvidence {
    let review = seen.review;
    let plan = seen.plan;
    if (!review || !plan) {
        for (const blocks of [watch.history, watch.live]) {
            for (const block of blocks) {
                const found = marksOf(block);
                review ||= found.diff;
                plan ||= found.checklist;
            }
        }
    }
    return {
        review,
        plan,
        files: seen.files || (place.folder !== undefined && !place.chat),
        // A stopped session offers Start in the same pill, so it counts as something to show.
        context: seen.context || watch.context !== undefined || canStart(watch),
    };
}
