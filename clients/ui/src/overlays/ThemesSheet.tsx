import { useEffect, useState } from "react";

import { CheckIcon, EyeIcon } from "../components/Icons.tsx";
import { switchTheme } from "../theme/activate.ts";
import { themeFile } from "../theme/apply.ts";
import { readStoredTheme } from "../theme/storage.ts";
import { THEME_NAMES, isThemeName, type ColorToken, type ThemeName } from "../theme/tokens.ts";
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
    const [current, setCurrent] = useState<ThemeName>(activeThemeName);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
            const name = THEME_NAMES[Number(event.key) - 1];
            if (name === undefined) return;
            switchTheme(name);
            setCurrent(name);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const choose = (name: ThemeName) => {
        switchTheme(name);
        setCurrent(name);
    };

    return (
        <OverlaySheet title="Choose Theme" Icon={EyeIcon} onClose={onClose} name="themes">
            <ul className="dialog-picks">
                {THEME_NAMES.map((name, index) => {
                    const swatches = swatchColors(name);
                    const isCurrent = name === current;
                    return (
                        <li key={name}>
                            <button
                                type="button"
                                className="dialog-pick"
                                data-theme-name={name}
                                data-selected={isCurrent}
                                aria-pressed={isCurrent}
                                onClick={() => choose(name)}
                            >
                                <span className="dialog-swatches" aria-hidden="true">
                                    {swatches.map((color, swatchIndex) => (
                                        <span key={swatchIndex} style={{ background: color }} />
                                    ))}
                                </span>
                                <span className="dialog-pick-body">
                                    <span className="dialog-pick-name">{THEME_TEXT[name].label}</span>
                                    <span className="dialog-pick-desc">{THEME_TEXT[name].description}</span>
                                </span>
                                <span className="dialog-key" aria-hidden="true">{index + 1}</span>
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
function activeThemeName(): ThemeName {
    const attribute = document.documentElement.getAttribute("data-theme");
    return attribute !== null && isThemeName(attribute) ? attribute : readStoredTheme();
}

function swatchColors(name: ThemeName): readonly string[] {
    const theme = themeFile(name);
    const colors: string[] = [];
    for (const token of SWATCH_TOKENS) {
        const value = theme.palette[theme.colors[token]];
        if (value !== undefined) colors.push(value);
    }
    return colors;
}
