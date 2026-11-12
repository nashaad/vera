import {
    defaultVeraConfigPath,
    loadOptionalVeraConfig,
    VeraConfigError,
} from "../../src/config.ts";
import {
    applyConfigSetAside,
    planConfigSetAside,
} from "../../src/config/set-aside.ts";
import { homeCommandPrefix } from "../../src/host/startup-failure.ts";
import {
    configAdviceCard,
    configDoneCard,
    configQuestionCard,
} from "./config-card.ts";
import type { CardPresenter } from "./startup-prompt.ts";

// Each pass removes one entry, so this only stops a file that keeps producing new failures.
const MAX_SET_ASIDE_STEPS = 25;

export interface ConfigRecoveryIo {
    readonly write: (text: string) => void;
    readonly confirm: (question: string) => Promise<boolean>;
    // A person at a terminal gets cards in place of the plain text and the [y/N] line.
    readonly cards?: CardPresenter;
}

// Only Vera's own config is set aside: a project file the error names is the user's to edit.
export function isDefaultConfigError(error: unknown): error is VeraConfigError {
    return error instanceof VeraConfigError
        && error.path === defaultVeraConfigPath();
}

/**
 * The one command that gets Vera running when nobody is there to answer a
 * prompt, or undefined when the failing file is not Vera's own config.
 */
export function configFixCommand(error: VeraConfigError): string | undefined {
    const fix = configFixParts(error);
    return fix === undefined ? undefined : `To ${fix.effect}, run: ${fix.command}`;
}

export function configFixParts(
    error: VeraConfigError,
): { readonly effect: string; readonly command: string } | undefined {
    if (!isDefaultConfigError(error)) return undefined;
    const plan = planConfigSetAside(error);
    return {
        effect: plan?.kind === "entry"
            ? `set aside ${plan.field} and keep the rest (a copy of the file is saved first)`
            : "move it aside to a backup and start with first-run setup",
        command: `${homeCommandPrefix()}vera doctor --config --yes`,
    };
}

export interface ConfigRecoveryOutcome {
    // The failure still standing, or undefined when Vera's config now loads.
    readonly error: VeraConfigError | undefined;
    // True when the failure was already printed with its advice, so the caller prints nothing more.
    readonly reported: boolean;
}

/**
 * Offers to set aside what the config failed on, one entry at a time, until the
 * config loads or the user declines.
 */
export async function recoverConfig(
    error: VeraConfigError,
    io: ConfigRecoveryIo,
    options: { readonly assumeYes?: boolean } = {},
): Promise<ConfigRecoveryOutcome> {
    let current = error;
    for (let step = 0; step < MAX_SET_ASIDE_STEPS; step += 1) {
        const plan = isDefaultConfigError(current)
            ? planConfigSetAside(current)
            : undefined;
        if (plan === undefined) return { error: current, reported: false };
        const cards = options.assumeYes === true ? undefined : io.cards;
        if (cards === undefined) io.write(`${current.message}\n`);
        const approved = options.assumeYes === true
            || (cards === undefined
                ? await io.confirm(`${plan.question} [y/N] `)
                : await cards.ask(configQuestionCard(current, plan)));
        if (!approved) {
            if (cards === undefined) io.write(`${configAdvice(current)}\n`);
            else cards.show(configAdviceCard(current, configFixParts(current)));
            return { error: current, reported: true };
        }
        const result = applyConfigSetAside(plan);
        if (cards === undefined) io.write(`${result.summary}\n`);
        else cards.show(configDoneCard(current.path, result));
        try {
            loadOptionalVeraConfig();
            return { error: undefined, reported: true };
        } catch (next) {
            if (!(next instanceof VeraConfigError)) throw next;
            current = next;
        }
    }
    return { error: current, reported: false };
}

// What follows the message: where to fix it, and the command for when nobody can answer a prompt.
export function configAdvice(error: VeraConfigError): string {
    const command = configFixCommand(error);
    return `Fix or remove ${error.path} and run Vera again.`
        + (command === undefined ? "" : `\n${command}`);
}
