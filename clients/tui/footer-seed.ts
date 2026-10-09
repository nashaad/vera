// A still example of every footer item, so the layout screen can show and
// move each one whatever the session holds right now.

import { homedir } from "node:os";
import { join } from "node:path";

import type { FooterItemContents } from "./footer-fit.ts";
import { footerItemContents } from "./footer-items.ts";
import { TUI_ACCENT, TUI_MUTED } from "./palette.ts";
import type { TuiStatusChunk } from "./status.ts";

export type FooterPreview = "idle" | "working";

export type FooterSeed = Readonly<Record<FooterPreview, FooterItemContents>>;

// The hints follow the current key bindings, so the caller passes them in.
export interface FooterSeedHints {
    readonly ready: string;
    readonly idleKeys: string;
    readonly keys: string;
    readonly strip: readonly TuiStatusChunk[];
}

const SEED_LIMITS = ["5h 88% left · week 60% left", "5h 88% · week 60%", "5h 88%"];
const SEED_PANES = ["crow mode", "split", "Ctrl+\\ layout", "Ctrl+G crow"];

export function footerSeed(hints: FooterSeedHints): FooterSeed {
    const base = {
        limits: SEED_LIMITS,
        place: { workspace: join(homedir(), "crow-nest"), branch: "plunder" },
        activityColumns: hints.strip.length,
        panes: SEED_PANES,
    };
    return {
        idle: footerItemContents({
            ...base,
            status: { text: hints.ready, color: TUI_MUTED },
            keys: hints.idleKeys,
            activity: [],
        }),
        working: footerItemContents({
            ...base,
            status: { text: "thinking · 12s", color: TUI_ACCENT },
            keys: hints.keys,
            activity: hints.strip,
        }),
    };
}
