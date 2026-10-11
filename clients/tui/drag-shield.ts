import { BoxRenderable, type CliRenderer, type MouseEvent } from "@opentui/core";

import { TOAST_Z_INDEX } from "./dialog-chrome.ts";

export interface DragShieldHandlers {
    drag(column: number): void;
    release(): void;
}

export interface DragShield {
    readonly box: BoxRenderable;
    begin(handlers: DragShieldHandlers): void;
    dragging(): boolean;
}

// OpenTUI hands a drag to whatever node is under the pointer at the first motion.
// A rail row rebuilt mid-drag drops the rest of the drag; this cover takes it instead.
export function createDragShield(renderer: CliRenderer): DragShield {
    let active: DragShieldHandlers | undefined;
    const box = new BoxRenderable(renderer, {
        id: "drag-shield",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        zIndex: TOAST_Z_INDEX + 1,
        visible: false,
        onMouseDrag: (event: MouseEvent) => {
            if (active === undefined) return;
            event.stopPropagation();
            active.drag(event.x);
        },
        onMouseUp: (event: MouseEvent) => {
            const handlers = active;
            active = undefined;
            box.visible = false;
            if (handlers === undefined) return;
            event.stopPropagation();
            handlers.release();
        },
    });
    return {
        box,
        begin(handlers): void {
            active = handlers;
            box.visible = true;
        },
        dragging(): boolean {
            return active !== undefined;
        },
    };
}
