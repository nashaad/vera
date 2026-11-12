import type { ThemeName } from "../theme/tokens.ts";

const LABELS: Record<ThemeName, string> = {
    dark: "Dark",
    light: "Light",
    "high-contrast": "High contrast",
};

export interface ThemePickerProps {
    readonly value: ThemeName;
    readonly names: readonly ThemeName[];
    readonly onChange: (name: ThemeName) => void;
}

export function ThemePicker({ value, names, onChange }: ThemePickerProps) {
    return (
        <div className="theme-group" role="group" aria-label="Theme">
            {names.map((name) => (
                <button
                    key={name}
                    type="button"
                    className="theme-button"
                    aria-pressed={name === value}
                    onClick={() => onChange(name)}
                >
                    {LABELS[name]}
                </button>
            ))}
        </div>
    );
}
