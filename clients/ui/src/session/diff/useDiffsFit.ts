import { useEffect, useState, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

// CodeView clamps its bottom-pinned sticky container when short content ends
// before the viewport, leaving a gap; flag the fit so it can stay in flow.
export function useDiffsFit<LAnnotation, Caret>(
    view: RefObject<CodeViewHandle<LAnnotation, Caret> | null>,
    revision: unknown,
): boolean {
    const [fits, setFits] = useState(false);
    useEffect(() => {
        let frame = 0;
        const measure = (): void => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const instance = view.current?.getInstance();
                if (instance === undefined) return;
                const next = instance.getScrollHeight() <= instance.getHeight() + 1;
                setFits((current) => current === next ? current : next);
            });
        };
        measure();
        const element = view.current?.getInstance()?.getContainerElement();
        const observer = element === undefined ? undefined : new ResizeObserver(measure);
        if (element !== undefined) observer?.observe(element);
        return () => {
            window.cancelAnimationFrame(frame);
            observer?.disconnect();
        };
    }, [view, revision]);
    return fits;
}
