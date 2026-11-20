import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { CheckIcon, EyeIcon, ListIcon } from "../components/Icons.tsx";
import { switchTheme } from "../theme/activate.ts";
import { resolveThemeChoice, themeFile } from "../theme/apply.ts";
import type { ImportedThemeSummary } from "../theme/imported.ts";
import { THEME_DESCRIPTIONS, THEME_LABELS } from "../theme/registry.ts";
import { readStoredTheme, readThemeView, storeThemeView, type ThemeView } from "../theme/storage.ts";
import { importedThemeId, isThemeChoice, isThemeName, THEME_NAMES, type ColorToken, type ThemeChoice, type ThemeFile } from "../theme/tokens.ts";
import { useImportedThemes } from "../theme/useImportedThemes.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface ThemesSheetProps {
    readonly onClose: () => void;
}

const SWATCH_TOKENS: readonly ColorToken[] = ["surface", "accent", "text"];

export function ThemesSheet({ onClose }: ThemesSheetProps) {
    const [current, setCurrent] = useState<ThemeChoice>(activeThemeChoice);
    const [view, setView] = useState<ThemeView>(readThemeView);
    const imported = useImportedThemes();
    const choices = useMemo<readonly ThemeChoice[]>(
        () => [...THEME_NAMES, ...imported.map((theme) => importedThemeId(theme.slug))],
        [imported],
    );
    const items = useMemo(
        () => choices.map((choice) => ({ choice, file: themeFile(choice), text: themeText(choice, imported) })),
        [choices, imported],
    );
    const [active, setActive] = useState(() => Math.max(0, choices.indexOf(current)));
    const highlight = Math.min(active, choices.length - 1);
    const listRef = useRef<HTMLUListElement>(null);

    const focusChoice = (index: number) => {
        setActive(index);
        const item = listRef.current?.querySelector<HTMLButtonElement>(`[data-theme-index="${index}"]`);
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: "nearest" });
    };

    useEffect(() => {
        const item = listRef.current?.querySelector<HTMLButtonElement>(`[data-theme-index="${highlight}"]`);
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: "nearest" });
    }, [highlight, view]);

    const choose = (choice: ThemeChoice, index: number) => {
        focusChoice(index);
        switchTheme(choice);
        setCurrent(choice);
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (/^[1-9]$/.test(event.key)) {
                const index = Number(event.key) - 1;
                const choice = choices[index];
                if (choice === undefined) return;
                event.preventDefault();
                choose(choice, index);
                return;
            }
            if (event.key === "Enter") {
                if (event.target instanceof Element && event.target.closest("button, input, select, textarea, a[href], [contenteditable='true']")) return;
                const choice = choices[highlight];
                if (choice !== undefined) {
                    event.preventDefault();
                    choose(choice, highlight);
                }
                return;
            }
            let next = highlight;
            if (event.key === "Home") next = 0;
            else if (event.key === "End") next = choices.length - 1;
            else if (event.key === "ArrowDown") next += view === "tile" ? 2 : 1;
            else if (event.key === "ArrowUp") next -= view === "tile" ? 2 : 1;
            else if (view === "tile" && event.key === "ArrowRight") next += 1;
            else if (view === "tile" && event.key === "ArrowLeft") next -= 1;
            else return;
            event.preventDefault();
            focusChoice(Math.max(0, Math.min(choices.length - 1, next)));
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [choices, highlight, view]);

    const changeView = (next: ThemeView) => {
        setView(next);
        storeThemeView(next);
    };

    const head = (
        <div className="themes-view-toggle" role="group" aria-label="Theme view">
            <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => changeView("list")}>
                <ListIcon />
            </button>
            <button type="button" aria-label="Tile view" aria-pressed={view === "tile"} onClick={() => changeView("tile")}>
                <GridIcon />
            </button>
        </div>
    );
    const foot = (
        <>
            <span><kbd className="kbd">{view === "tile" ? "↑↓←→" : "↑↓"}</kbd>Select</span>
            <span><kbd className="kbd">↵</kbd>Choose</span>
            <span><kbd className="kbd">1-9</kbd>Jump</span>
            <span><kbd className="kbd">esc</kbd>Close</span>
        </>
    );

    return (
        <OverlaySheet title="Choose Theme" Icon={EyeIcon} onClose={onClose} name="themes" head={head} foot={foot}>
            <ul className={view === "list" ? "themes-list" : "themes-list themes-grid"} ref={listRef}>
                {items.map(({ choice, file, text }, index) => {
                    const isCurrent = choice === current;
                    return (
                        <li key={choice}>
                            <button
                                type="button"
                                className={view === "list" ? "theme-row" : "theme-tile"}
                                data-theme-name={choice}
                                data-theme-index={index}
                                data-highlighted={index === highlight}
                                aria-pressed={isCurrent}
                                aria-label={text.description ? `${text.label}. ${text.description}` : text.label}
                                title={text.description}
                                tabIndex={index === highlight ? 0 : -1}
                                onFocus={() => setActive(index)}
                                onClick={() => choose(choice, index)}
                            >
                                {view === "list" ? (
                                    <>
                                        <span className="theme-swatches" aria-hidden="true">
                                            {SWATCH_TOKENS.map((token) => <span key={token} style={{ background: color(file, token) }} />)}
                                        </span>
                                        <span className="theme-row-name">{text.label}</span>
                                        <span className="theme-row-description">{text.description}</span>
                                        {isCurrent ? <CheckIcon className="theme-row-check" /> : <span className="theme-row-key">{index < 9 ? index + 1 : ""}</span>}
                                    </>
                                ) : (
                                    <>
                                        <ThemePreview file={file} current={isCurrent} />
                                        <span className="theme-tile-label">{text.label}</span>
                                    </>
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </OverlaySheet>
    );
}

function GridIcon() {
    return (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="4" y="4" width="6" height="6" rx="1" />
            <rect x="14" y="4" width="6" height="6" rx="1" />
            <rect x="4" y="14" width="6" height="6" rx="1" />
            <rect x="14" y="14" width="6" height="6" rx="1" />
        </svg>
    );
}

function ThemePreview({ file, current }: { readonly file: ThemeFile; readonly current: boolean }) {
    const style = {
        "--theme-surface": color(file, "surface"),
        "--theme-sidebar": color(file, "surface-sidebar"),
        "--theme-panel": color(file, "surface-panel"),
        "--theme-border": color(file, "border"),
        "--theme-accent": color(file, "accent"),
        "--theme-accent-text": color(file, "accent-text"),
        "--theme-text": color(file, "text"),
        "--theme-text-muted": color(file, "text-muted"),
        "--theme-text-dim": color(file, "text-dim"),
        "--theme-text-disabled": color(file, "text-disabled"),
    } as CSSProperties;
    return (
        <span className="theme-preview" style={style} aria-hidden="true">
            <span className="theme-preview-sidebar"><i /><i /><i /></span>
            <span className="theme-preview-main">
                <i /><i />
                <span className="theme-preview-panel"><b /><span><i /><i /></span></span>
            </span>
            {current ? <span className="theme-preview-check"><CheckIcon /></span> : null}
        </span>
    );
}

function activeThemeChoice(): ThemeChoice {
    const attribute = document.documentElement.getAttribute("data-theme");
    return attribute !== null && isThemeChoice(attribute) ? resolveThemeChoice(attribute) : readStoredTheme();
}

function themeText(choice: ThemeChoice, imported: readonly ImportedThemeSummary[]): { readonly label: string; readonly description: string } {
    if (isThemeName(choice)) return { label: THEME_LABELS[choice], description: THEME_DESCRIPTIONS[choice] };
    const theme = imported.find((entry) => importedThemeId(entry.slug) === choice);
    return { label: theme?.name ?? choice, description: theme === undefined ? "" : `Imported. ${theme.source}.` };
}

function color(file: ThemeFile, token: ColorToken): string {
    return file.palette[file.colors[token]] ?? "transparent";
}
