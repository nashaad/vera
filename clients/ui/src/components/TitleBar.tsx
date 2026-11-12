import { useLayoutEffect, useRef } from "react";

import { HeaderToggle } from "./HeaderToggle.tsx";
import { HistoryButtons } from "./HistoryButtons.tsx";

export interface TitleBarProps {
    readonly title: string;
    // While the sidebar is hidden its toggle, back and forward, and the room for the window controls move here.
    readonly sidebarShown: boolean;
    readonly onHeight?: (height: number) => void;
}

// The header of the main area. The sidebar's top row has the same height, so one report serves both.
export function TitleBar({ title, sidebarShown, onHeight }: TitleBarProps) {
    const ref = useRef<HTMLElement>(null);
    // Density tokens change the bar height with the theme, so keep reporting it.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || onHeight === undefined) return;
        const report = (): void => onHeight(element.getBoundingClientRect().height);
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => observer.disconnect();
    }, [onHeight]);
    return (
        <header ref={ref} className="titlebar" data-sidebar={sidebarShown ? "shown" : "hidden"}>
            {sidebarShown ? null : (
                <span className="titlebar-controls">
                    <HeaderToggle location="sidebar" />
                    <HistoryButtons />
                </span>
            )}
            <span className="titlebar-title">{title}</span>
            <span className="spacer" />
            <HeaderToggle location="rightPane" lit />
        </header>
    );
}
