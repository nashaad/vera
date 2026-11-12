import { useEffect, useState } from "react";

import { switchTheme } from "../../theme/activate.ts";
import { changeAppearance, DENSITIES, readAppearance, SCALES, type Appearance } from "../../theme/preferences.ts";
import { THEME_NAMES, type ThemeName } from "../../theme/tokens.ts";
import { DENSITY_LABELS, SCALE_LABELS, THEME_LABELS, themeFromAttribute, themeSwatch } from "./appearance.ts";
import { SettingRow } from "./SettingRow.tsx";

// The theme can also change from the View menu, so the cards follow the root attribute.
function useActiveTheme(): ThemeName {
    const [theme, setTheme] = useState<ThemeName>(() => themeFromAttribute(document.documentElement.getAttribute("data-theme")));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setTheme(themeFromAttribute(document.documentElement.getAttribute("data-theme")));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

function ThemeCard({ name, active }: { readonly name: ThemeName; readonly active: boolean }) {
    const swatch = themeSwatch(name);
    return (
        <button type="button" className="appearance-theme" aria-pressed={active} onClick={() => switchTheme(name)}>
            <span className="appearance-preview" style={{ background: swatch.surface, borderColor: swatch.border }}>
                <span className="appearance-preview-line" style={{ background: swatch.text }} />
                <span className="appearance-preview-line short" style={{ background: swatch.text }} />
                <span className="appearance-preview-dot" style={{ background: swatch.accent }} />
            </span>
            <span className="appearance-theme-name">{THEME_LABELS[name]}</span>
        </button>
    );
}

interface SegmentedProps<T extends string> {
    readonly label: string;
    readonly options: readonly T[];
    readonly labels: Readonly<Record<T, string>>;
    readonly value: T;
    readonly onChange: (value: T) => void;
}

function Segmented<T extends string>({ label, options, labels, value, onChange }: SegmentedProps<T>) {
    return (
        <div className="appearance-seg" role="group" aria-label={label}>
            {options.map((option) => (
                <button key={option} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>
                    {labels[option]}
                </button>
            ))}
        </div>
    );
}

export function AppearanceSection() {
    const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
    const activeTheme = useActiveTheme();

    function save(next: Appearance): void {
        changeAppearance(next);
        setAppearance(next);
    }

    return (
        <>
            <h1>Appearance</h1>
            <h2 className="settings-sec">Theme</h2>
            <div className="appearance-themes">
                {THEME_NAMES.map((name) => (
                    <ThemeCard key={name} name={name} active={name === activeTheme} />
                ))}
            </div>
            <SettingRow name="Text size" description="Scales the text of the interface in this window.">
                <Segmented
                    label="Text size"
                    options={SCALES}
                    labels={SCALE_LABELS}
                    value={appearance.textSize}
                    onChange={(textSize) => save({ ...appearance, textSize })}
                />
            </SettingRow>
            <SettingRow name="Code size" description="Scales code, diffs and code blocks.">
                <Segmented
                    label="Code size"
                    options={SCALES}
                    labels={SCALE_LABELS}
                    value={appearance.codeSize}
                    onChange={(codeSize) => save({ ...appearance, codeSize })}
                />
            </SettingRow>
            <SettingRow name="Density" description="The space between rows and controls.">
                <Segmented
                    label="Density"
                    options={DENSITIES}
                    labels={DENSITY_LABELS}
                    value={appearance.density}
                    onChange={(density) => save({ ...appearance, density })}
                />
            </SettingRow>
            <SettingRow name="Reduce motion" description="Turns off animated transitions in this window.">
                <button
                    type="button"
                    role="switch"
                    aria-checked={appearance.reduceMotion}
                    aria-label="Reduce motion"
                    className="appearance-switch"
                    onClick={() => save({ ...appearance, reduceMotion: !appearance.reduceMotion })}
                >
                    <span className="appearance-switch-knob" />
                </button>
            </SettingRow>
            <p className="settings-note">These settings apply to this window and are kept in its own storage.</p>
        </>
    );
}
