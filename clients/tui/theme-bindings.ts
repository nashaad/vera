import type { TuiTheme } from "./theme.ts";

export type TuiThemeColorRole = Exclude<{
    [Role in keyof TuiTheme]-?: TuiTheme[Role] extends string
        ? Role
        : never;
}[keyof TuiTheme], "chrome">;

export type TuiThemeColorValue = TuiThemeColorRole
    | ((theme: TuiTheme) => string);

export type TuiThemeBinding = (theme: TuiTheme) => void;

export type TuiThemeProperty =
    | "fg"
    | "bg"
    | "backgroundColor"
    | "focusedBackgroundColor"
    | "textColor"
    | "focusedTextColor"
    | "cursorColor"
    | "placeholderColor"
    | "borderColor"
    | "focusedBorderColor";

type TuiThemeTargetProperty<Target extends object> = Extract<
    TuiThemeProperty,
    keyof Target
>;

/**
 * Declares which theme roles paint an existing renderable. Keeping this as
 * data makes a live theme change follow the same map as the first paint.
 * OpenTUI accepts strings through color setters whose public getter type is
 * RGBA, so the supported writable names are explicit instead of inferred.
 */
export function tuiThemeProperties<Target extends object>(
    target: Target,
    properties: Partial<Record<
        TuiThemeTargetProperty<Target>,
        TuiThemeColorValue
    >>,
): TuiThemeBinding {
    return (theme) => {
        for (const [property, value] of Object.entries(properties) as Array<[
            TuiThemeTargetProperty<Target>,
            TuiThemeColorValue | undefined,
        ]>) {
            if (value === undefined) continue;
            if (!(property in target)) {
                throw new TypeError(
                    `Theme property ${String(property)} is not present on its target`,
                );
            }
            const applied = Reflect.set(
                target,
                property,
                typeof value === "function" ? value(theme) : theme[value],
            );
            if (!applied) {
                throw new TypeError(
                    `Theme property ${String(property)} could not be updated`,
                );
            }
        }
    };
}

export function applyTuiThemeBindings(
    theme: TuiTheme,
    bindings: readonly TuiThemeBinding[],
): void {
    for (const binding of bindings) {
        binding(theme);
    }
}
