import { activateTheme, switchTheme } from "./activate.ts";
import type { ThemeChoice } from "./tokens.ts";

export function createPickerPreview(initial: ThemeChoice, activate = activateTheme, commit = switchTheme) {
    let saved = initial;
    let displayed = initial;
    return {
        preview(choice: ThemeChoice) {
            if (choice === displayed) return;
            activate(choice);
            displayed = choice;
        },
        commit(choice: ThemeChoice) {
            commit(choice);
            saved = choice;
            displayed = choice;
        },
        restore() {
            if (displayed === saved) return;
            activate(saved);
            displayed = saved;
        },
    };
}
