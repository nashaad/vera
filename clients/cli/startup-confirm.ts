import { createInterface } from "node:readline/promises";

import { HostUnresponsiveError } from "../../src/host/lockfile.ts";
import type { StartupCard } from "./startup-card.ts";

// Plain prompts end in a hint such as `[y/N] `; a card shows the choices itself.
export function withoutAnswerHint(question: string): string {
    return question.replace(/\s*\[y\/N\]\s*$/i, "");
}

async function askLine(question: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await prompt.question(question)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    } finally {
        prompt.close();
    }
}

async function ask(card: StartupCard, plain: string): Promise<boolean> {
    const { terminalCardPresenter } = await import("./startup-prompt.ts");
    const cards = terminalCardPresenter();
    return cards === undefined ? askLine(plain) : cards.ask(card);
}

export async function confirmHostReset(question: string): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    return ask({
        kind: "question",
        title: "Vera host reset",
        body: [withoutAnswerHint(question)],
        choices: [
            { key: "y", label: "back up and reset" },
            { key: "n", label: "cancel", isDefault: true },
        ],
    }, question);
}

export async function confirmBusyHostUpgrade(error?: Error): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const unresponsive = error instanceof HostUnresponsiveError;
    const plain = unresponsive
        ? `The resident Vera host (PID ${error.pid}) is not responding. Replace it? [y/N] `
        : "An older Vera host is busy. Restart it and disconnect attached clients? [y/N] ";
    return ask(unresponsive
        ? {
            kind: "question",
            title: "The resident Vera host is not responding",
            rows: [{ label: "host", value: `PID ${error.pid}` }],
            body: ["Replace it?"],
            choices: [
                { key: "y", label: "replace it" },
                { key: "n", label: "quit", isDefault: true },
            ],
        }
        : {
            kind: "question",
            title: "An older Vera host is busy",
            body: ["Restart it and disconnect attached clients?"],
            choices: [
                { key: "y", label: "restart it" },
                { key: "n", label: "quit", isDefault: true },
            ],
        }, plain);
}
