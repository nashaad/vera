export interface BuiltinTheme<Name extends string = string> {
    readonly name: Name;
    readonly label: string;
    readonly description: string;
    readonly colorScheme: "dark" | "light";
}

export const BUILTIN_THEME_REGISTRY = [
    { name: "dark", label: "Dark", description: "Dark surfaces with light text.", colorScheme: "dark" },
    { name: "light", label: "Light", description: "Light surfaces with dark text.", colorScheme: "light" },
    { name: "high-contrast", label: "High contrast", description: "Stronger contrast between surfaces, borders and text.", colorScheme: "dark" },
    { name: "default", label: "Vera Blue", description: "Vera's original palette", colorScheme: "dark" },
    { name: "vera-purple", label: "Vera Purple", description: "violet haze on black", colorScheme: "dark" },
    { name: "muted-blue", label: "Muted Blue", description: "blue transcript, muted details", colorScheme: "dark" },
    { name: "onyx", label: "Onyx", description: "true black, orange and chrome", colorScheme: "dark" },
    { name: "palenight", label: "Palenight", description: "soft blue and purple", colorScheme: "dark" },
    { name: "synthwave", label: "Synthwave", description: "bright cyan and neon", colorScheme: "dark" },
    { name: "nightowl", label: "Night Owl", description: "deep blue, low glare", colorScheme: "dark" },
    { name: "github", label: "GitHub", description: "GitHub dark palette", colorScheme: "dark" },
    { name: "github-light", label: "GitHub Light", description: "GitHub light palette", colorScheme: "light" },
    { name: "gruvbox-dark-hard", label: "Gruvbox Dark Hard", description: "warm brown, bright retro accents", colorScheme: "dark" },
    { name: "gruvbox-light-hard", label: "Gruvbox Light Hard", description: "cream paper, warm ink", colorScheme: "light" },
    { name: "midnight-blue", label: "Midnight Blue", description: "navy, gold, and cool white", colorScheme: "dark" },
    { name: "midnight-blue-ii", label: "Midnight Blue II", description: "gold accent, blue code", colorScheme: "dark" },
    { name: "norton-commander", label: "NC", description: "blue panels, cyan bars, yellow detail", colorScheme: "dark" },
    { name: "nc-navy", label: "NC Navy", description: "deep navy panels, cyan bars", colorScheme: "dark" },
    { name: "windows-31", label: "retro31", description: "navy windows on teal", colorScheme: "light" },
    { name: "vera-orange", label: "Vera Orange", description: "near-black, warm white and orange", colorScheme: "dark" },
] as const satisfies readonly BuiltinTheme[];

export type ThemeName = (typeof BUILTIN_THEME_REGISTRY)[number]["name"];
export const THEME_NAMES: readonly ThemeName[] = BUILTIN_THEME_REGISTRY.map((theme) => theme.name);

export function builtinRecord<Value>(value: (theme: (typeof BUILTIN_THEME_REGISTRY)[number]) => Value): Readonly<Record<ThemeName, Value>> {
    return Object.fromEntries(BUILTIN_THEME_REGISTRY.map((theme) => [theme.name, value(theme)])) as Record<ThemeName, Value>;
}

export const THEME_LABELS = builtinRecord((theme) => theme.label);
export const THEME_DESCRIPTIONS = builtinRecord((theme) => theme.description);
