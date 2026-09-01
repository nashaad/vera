import type { BoxRenderable, Renderable } from "@opentui/core";

export interface TuiExperimentalSlotSet {
    readonly transcriptTop: BoxRenderable;
    readonly transcriptBottom: BoxRenderable;
    readonly footer: BoxRenderable;
    readonly composerAdornment: BoxRenderable;
    readonly overlay: BoxRenderable;
}

export function refreshTuiExperimentalSlotVisibility(
    slots: TuiExperimentalSlotSet,
): void {
    slots.transcriptTop.visible = hasVisibleChildren(slots.transcriptTop);
    slots.transcriptBottom.visible = hasVisibleChildren(slots.transcriptBottom);
    slots.footer.visible = hasVisibleChildren(slots.footer);
    slots.composerAdornment.visible = hasVisibleChildren(slots.composerAdornment);
    slots.overlay.visible = hasVisibleChildren(slots.overlay);
}

export function tuiExperimentalBottomInsetRows(
    footer: BoxRenderable,
    composerAdornment: BoxRenderable,
): number {
    return visibleSlotRows(footer) + visibleSlotRows(composerAdornment);
}

function hasVisibleChildren(renderable: Renderable): boolean {
    return renderable.getChildren().some((child) => child.visible);
}

function visibleSlotRows(slot: BoxRenderable): number {
    if (!slot.visible) return 0;
    return Math.max(
        slot.height,
        slot.getChildren().reduce(
            (total, child) => total + renderableRows(child),
            0,
        ),
    );
}

function renderableRows(renderable: Renderable): number {
    if (!renderable.visible) return 0;
    if (renderable.height > 0) return renderable.height;
    const childRows = renderable.getChildren()
        .filter((child) => child.visible)
        .map(renderableRows);
    if (childRows.length === 0) return 1;
    return renderable.primaryAxis === "column"
        ? childRows.reduce((total, rows) => total + rows, 0)
        : Math.max(...childRows);
}
