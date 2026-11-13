import { useEffect, useState } from "react";

import { CheckIcon, EyeIcon } from "../components/Icons.tsx";
import { switchTheme } from "../theme/activate.ts";
import { themeFile } from "../theme/apply.ts";
import { importedThemeId, isThemeChoice, THEME_NAMES, isThemeName, type ColorToken, type ThemeChoice, type ThemeName } from "../theme/tokens.ts";
import { resolveThemeChoice } from "../theme/apply.ts";
import { readStoredTheme } from "../theme/storage.ts";
import { useImportedThemes } from "../theme/useImportedThemes.ts";
import type { ImportedThemeSummary } from "../theme/imported.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface ThemesSheetProps {
    readonly onClose: () => void;
}

const THEME_TEXT: Readonly<Record<ThemeName, { readonly label: string; readonly description: string }>> = {
    dark: { label: "Dark", description: "Dark surfaces with light text." },
    light: { label: "Light", description: "Light surfaces with dark text." },
    "high-contrast": { label: "High contrast", description: "Stronger contrast between surfaces, borders and text." },
};

const SWATCH_TOKENS: readonly ColorToken[] = ["surface", "surface-panel", "accent", "text", "border"];

export function ThemesSheet({ onClose }: ThemesSheetProps) {
    const [current, setCurrent] = useState<ThemeChoice>(activeThemeChoice);
    const imported = useImportedThemes();
    const choices: readonly ThemeChoice[] = [...THEME_NAMES, ...imported.map((theme) => importedThemeId(theme.slug))];

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
            const choice = choices[Number(event.key) - 1];
            if (choice === undefined) return;
            switchTheme(choice);
            setCurrent(choice);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [choices.join(" ")]);

    const choose = (choice: ThemeChoice) => {
        switchTheme(choice);
        setCurrent(choice);
    };

    return (
        <OverlaySheet title="Choose Theme" Icon={EyeIcon} onClose={onClose} name="themes">
            <ul className="dialog-picks">
                {choices.map((choice, index) => {
                    const swatches = swatchColors(choice);
                    const isCurrent = choice === current;
                    const text = themeText(choice, imported);
                    return (
                        <li key={choice}>
                            <button
                                type="button"
                                className="dialog-pick"
                                data-theme-name={choice}
                                data-selected={isCurrent}
                                aria-pressed={isCurrent}
                                onClick={() => choose(choice)}
                            >
                                <span className="dialog-swatches" aria-hidden="true">
                                    {swatches.map((color, swatchIndex) => (
                                        <span key={swatchIndex} style={{ background: color }} />
                                    ))}
                                </span>
                                <span className="dialog-pick-body">
                                    <span className="dialog-pick-name">{text.label}</span>
                                    <span className="dialog-pick-desc">{text.description}</span>
                                </span>
                                <span className="dialog-key" aria-hidden="true">{index < 9 ? index + 1 : ""}</span>
                                {isCurrent ? <CheckIcon className="dialog-pick-check" /> : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
            <p className="dialog-text">Text size, density and motion are in Settings, under Appearance.</p>
        </OverlaySheet>
    );
}

// The theme the page is showing, which the root attribute names; the stored choice covers a page not yet applied.
function activeThemeChoice(): ThemeChoice {
    const attribute = document.documentElement.getAttribute("data-theme");
    return attribute !== null && isThemeChoice(attribute) ? resolveThemeChoice(attribute) : readStoredTheme();
}

function themeText(choice: ThemeChoice, imported: readonly ImportedThemeSummary[]): { readonly label: string; readonly description: string } {
    if (isThemeName(choice)) return THEME_TEXT[choice];
    const theme = imported.find((entry) => importedThemeId(entry.slug) === choice);
    return { label: theme?.name ?? choice, description: theme === undefined ? "" : `Imported. ${theme.source}.` };
}

function swatchColors(choice: ThemeChoice): readonly string[] {
    const theme = themeFile(choice);
    const colors: string[] = [];
    for (const token of SWATCH_TOKENS) {
        const value = theme.palette[theme.colors[token]];
        if (value !== undefined) colors.push(value);
    }
    return colors;
}
