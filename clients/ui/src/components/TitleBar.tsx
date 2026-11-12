import { useLayoutEffect, useRef } from "react";

export interface TitleBarProps {
    readonly onHeight: (height: number) => void;
}

export function TitleBar({ onHeight }: TitleBarProps) {
    const ref = useRef<HTMLElement>(null);
    // Density tokens change the bar height with the theme, so keep reporting it.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null) return;
        const report = (): void => onHeight(element.getBoundingClientRect().height);
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => observer.disconnect();
    }, [onHeight]);
    return (
        <header ref={ref} className="titlebar">
            <span className="titlebar-title">Vera</span>
        </header>
    );
}
