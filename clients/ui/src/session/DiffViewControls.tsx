import type { DiffStyle, OverflowMode } from "./diff/pierreOptions.ts";

interface DiffViewControlsProps {
    readonly diffStyle: DiffStyle;
    readonly overflow: OverflowMode;
    readonly onDiffStyle: (style: DiffStyle) => void;
    readonly onOverflow: (overflow: OverflowMode) => void;
}

export function DiffViewControls({ diffStyle, overflow, onDiffStyle, onOverflow }: DiffViewControlsProps) {
    return <div className="diff-view-controls" role="group" aria-label="Diff view">
        <button
            type="button"
            className="diff-view-toggle"
            aria-pressed={diffStyle === "unified"}
            title="Show one code column"
            onClick={() => onDiffStyle("unified")}
        >Unified</button>
        <button
            type="button"
            className="diff-view-toggle"
            aria-pressed={diffStyle === "split"}
            title="Show old and new code side by side"
            onClick={() => onDiffStyle("split")}
        >Split</button>
        <button
            type="button"
            className="diff-view-toggle"
            aria-pressed={overflow === "wrap"}
            title="Wrap long lines"
            onClick={() => onOverflow("wrap")}
        >Wrap</button>
        <button
            type="button"
            className="diff-view-toggle"
            aria-pressed={overflow === "scroll"}
            title="Scroll long lines sideways"
            onClick={() => onOverflow("scroll")}
        >Scroll</button>
    </div>;
}
