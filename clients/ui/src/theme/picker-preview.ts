import { activateTheme, switchTheme } from "./activate.ts";
import type { ThemeChoice } from "./tokens.ts";

export function createPickerPreview(initial: ThemeChoice, activate = activateTheme, commit = switchTheme) {
    let saved = initial;
    let displayed = initial;
    const preview = (choice: ThemeChoice) => {
        if (choice === displayed) return;
        activate(choice);
        displayed = choice;
    };
    const restore = () => {
        if (displayed === saved) return;
        activate(saved);
        displayed = saved;
    };
    return {
        preview,
        commit(choice: ThemeChoice) {
            commit(choice);
            saved = choice;
            displayed = choice;
        },
        restore,
        search(choices: readonly ThemeChoice[], query: string): ThemeChoice | undefined {
            const first = choices[0];
            if (query.length > 0 && first !== undefined) {
                preview(first);
                return first;
            }
            restore();
            return query.length === 0 ? saved : undefined;
        },
    };
}
