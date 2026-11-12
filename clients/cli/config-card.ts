import type { VeraConfigError } from "../../src/config.ts";
import type {
    ConfigSetAsidePlan,
    ConfigSetAsideResult,
} from "../../src/config/set-aside.ts";
import type { StartupCard, StartupCardRow } from "./startup-card.ts";

export function configRows(error: VeraConfigError): StartupCardRow[] {
    return [
        { label: "file", value: error.path },
        ...(error.field === undefined || error.field === ""
            ? []
            : [{ label: "field", value: error.field, bold: true }]),
        { label: "reason", value: error.reason },
    ];
}

export function configQuestionCard(
    error: VeraConfigError,
    plan: ConfigSetAsidePlan,
): StartupCard {
    const entry = plan.kind === "entry";
    return {
        kind: "error",
        title: "Vera can't start",
        rows: configRows(error),
        body: entry
            ? [
                `Set aside ${plan.field} and start Vera?`,
                "A backup is saved first.",
                "Once Vera starts, ask it to fix the entry from the backup.",
            ]
            : [
                "Move the config file aside and start with first-run setup?",
                "The file is kept as a backup beside it.",
                "Once Vera starts, ask it to restore your settings from the backup.",
            ],
        choices: [
            { key: "y", label: entry ? "set aside and start" : "move aside and start" },
            { key: "n", label: "quit", isDefault: true },
        ],
    };
}

export function configDoneCard(
    path: string,
    result: ConfigSetAsideResult,
): StartupCard {
    return {
        kind: "done",
        title: result.kind === "entry" ? `Removed ${result.field}` : "Moved the config file aside",
        rows: [
            { label: "file", value: path },
            { label: "backup", value: result.backupPath },
        ],
    };
}

export function configAdviceCard(
    error: VeraConfigError,
    fix: { readonly effect: string; readonly command: string } | undefined,
): StartupCard {
    return {
        kind: "error",
        compact: true,
        title: "Vera did not start",
        body: [
            `Fix or remove ${error.path} and run Vera again.`,
            ...(fix === undefined
                ? []
                : ["", `To ${fix.effect}, run:`, "", { command: fix.command }]),
        ],
    };
}
