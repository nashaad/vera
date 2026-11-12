import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { MenuEntry } from "../commands/menus.ts";
import { CheckIcon } from "../components/Icons.tsx";

export interface ContextMenuProps {
    readonly entries: readonly MenuEntry[];
    readonly x: number;
    readonly y: number;
    readonly onRun: (command: string, args: unknown) => void;
    readonly onClose: () => void;
}

function enabledIndexes(entries: readonly MenuEntry[]): number[] {
    const indexes: number[] = [];
    entries.forEach((entry, index) => {
        if (entry.kind === "item" && entry.disabled !== true) indexes.push(index);
    });
    return indexes;
}

export function ContextMenu({ entries, x, y, onRun, onClose }: ContextMenuProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x, y });
    const [focused, setFocused] = useState<number | undefined>(() => enabledIndexes(entries)[0]);

    // Keeps the menu inside the window and puts focus in it; focus goes back on close.
    useLayoutEffect(() => {
        const menu = ref.current;
        if (menu === null) return;
        const box = menu.getBoundingClientRect();
        setPosition({
            x: Math.max(0, Math.min(x, window.innerWidth - box.width)),
            y: Math.max(0, Math.min(y, window.innerHeight - box.height)),
        });
        const previous = document.activeElement;
        menu.focus();
        return () => {
            if (previous instanceof HTMLElement) previous.focus();
        };
    }, [x, y]);

    useEffect(() => {
        const away = (event: Event): void => {
            if (event.target instanceof Node && ref.current?.contains(event.target)) return;
            onClose();
        };
        window.addEventListener("pointerdown", away, true);
        window.addEventListener("blur", onClose);
        window.addEventListener("resize", onClose);
        return () => {
            window.removeEventListener("pointerdown", away, true);
            window.removeEventListener("blur", onClose);
            window.removeEventListener("resize", onClose);
        };
    }, [onClose]);

    const move = (step: 1 | -1): void => {
        const indexes = enabledIndexes(entries);
        if (indexes.length === 0) return;
        const at = focused === undefined ? -1 : indexes.indexOf(focused);
        const next = at === -1
            ? (step === 1 ? 0 : indexes.length - 1)
            : (at + step + indexes.length) % indexes.length;
        setFocused(indexes[next]);
    };

    const activate = (index: number | undefined): void => {
        const entry = index === undefined ? undefined : entries[index];
        if (entry === undefined || entry.kind !== "item" || entry.disabled === true) return;
        onClose();
        onRun(entry.command, entry.args);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else if (event.key === "Home") setFocused(enabledIndexes(entries)[0]);
        else if (event.key === "End") setFocused(enabledIndexes(entries).at(-1));
        else if (event.key === "Enter" || event.key === " ") activate(focused);
        else if (event.key === "Escape" || event.key === "Tab") onClose();
        else return;
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        <div
            ref={ref}
            className="menu"
            role="menu"
            tabIndex={-1}
            style={{ left: position.x, top: position.y }}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => event.preventDefault()}
        >
            {entries.map((entry, index) => {
                if (entry.kind === "separator") {
                    return <div key={index} className="menu-separator" role="separator" />;
                }
                const disabled = entry.disabled === true;
                const checkable = entry.checked !== undefined;
                return (
                    <div
                        key={index}
                        className="menu-item"
                        role={checkable ? "menuitemcheckbox" : "menuitem"}
                        aria-checked={checkable ? entry.checked : undefined}
                        aria-disabled={disabled}
                        data-focused={focused === index}
                        onPointerMove={() => {
                            if (!disabled) setFocused(index);
                        }}
                        onClick={() => activate(index)}
                    >
                        <span className="menu-check">
                            {entry.checked === true ? <CheckIcon /> : null}
                        </span>
                        {entry.label}
                    </div>
                );
            })}
        </div>
    );
}
