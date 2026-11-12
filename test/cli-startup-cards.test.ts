import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootQuestionCard } from "../clients/cli/boot-question-card.ts";
import { failureCard } from "../clients/cli/failure-card.ts";
import { recoverConfig } from "../clients/cli/config-recovery.ts";
import { renderStartupCard, type StartupCard } from "../clients/cli/startup-card.ts";
import type { CardPresenter } from "../clients/cli/startup-prompt.ts";
import { withoutAnswerHint } from "../clients/cli/startup-confirm.ts";
import { HostBootLoopError } from "../clients/host/boot-failures.ts";
import { loadOptionalVeraConfig, VeraConfigError } from "../src/config.ts";
import { HostHomeUnusableError, HostSocketPathTooLongError, homeSocketPathLimit, socketPlatformName } from "../src/host/startup-failure.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
    previousHome = process.env.VERA_HOME;
    home = mkdtempSync(join(tmpdir(), "vsc-"));
    process.env.VERA_HOME = home;
});

afterEach(() => {
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
});

function presenter(answer: boolean): { cards: CardPresenter; asked: StartupCard[]; shown: StartupCard[] } {
    const asked: StartupCard[] = [];
    const shown: StartupCard[] = [];
    return {
        asked,
        shown,
        cards: {
            style: { color: "none" },
            show: (card) => { shown.push(card); },
            ask: async (card) => { asked.push(card); return answer; },
        },
    };
}

function failingConfig(): VeraConfigError {
    writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ schema_version: 1, provider: "deepseek", model: "deepseek-flash", extensions: [{}] }),
    );
    try {
        loadOptionalVeraConfig();
    } catch (error) {
        return error as VeraConfigError;
    }
    throw new Error("config loaded");
}

test("@core a config failure on a terminal asks on a card and follows up with a done card", async () => {
    const error = failingConfig();
    const { cards, asked, shown } = presenter(true);
    const written: string[] = [];

    const outcome = await recoverConfig(error, {
        write: (text) => { written.push(text); },
        confirm: async () => { throw new Error("the plain prompt must not run"); },
        cards,
    });

    expect(outcome).toEqual({ error: undefined, reported: true });
    expect(written).toEqual([]);
    const plain = renderStartupCard(asked[0]!, { columns: 64, color: "none", home });
    expect(plain).toContain("│ ✗ Vera can't start");
    expect(plain).toContain("  file    ~/config.json");
    expect(plain).toContain("  field   extensions[0]");
    expect(plain).toContain("  reason  path is missing; it must be an absolute path");
    expect(plain).toContain("  Set aside extensions[0] and start Vera?");
    expect(plain).toContain("  A backup is saved first.");
    expect(plain).toContain("  Once Vera starts, ask it to fix the entry from the backup.");
    expect(plain).toContain("[y] set aside and start      [N] quit");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.kind).toBe("done");
    expect(shown[0]!.title).toBe("Removed extensions[0]");
    const backup = readdirSync(home).find((name) => name.endsWith(".bak"))!;
    expect(shown[0]!.rows).toEqual([
        { label: "file", value: join(home, "config.json") },
        { label: "backup", value: join(home, backup) },
    ]);
});

test("declining on a card leaves the file and shows the advice with the doctor command", async () => {
    const error = failingConfig();
    const { cards, shown } = presenter(false);

    const outcome = await recoverConfig(error, {
        write: () => { throw new Error("plain text must not be written"); },
        confirm: async () => true,
        cards,
    });

    expect(outcome.reported).toBe(true);
    expect(outcome.error).toBe(error);
    expect(readdirSync(home).filter((name) => name.endsWith(".bak"))).toEqual([]);
    const text = renderStartupCard(shown[0]!, { columns: 200, color: "none" });
    expect(text.startsWith("✗ Vera did not start\n\n")).toBe(true);
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain(`Fix or remove ${join(home, "config.json")} and run Vera again.`);
    expect(flat).toContain("To set aside extensions[0] and keep the rest (a copy of the file is saved first), run:");
    // The command is one line, so it can be copied whole.
    expect(text).toContain(`\n    VERA_HOME=${home} vera doctor --config --yes\n`);
    expect(text).not.toContain("╭");
});

test("a config whose first failure is the whole file asks to move it aside", async () => {
    writeFileSync(join(home, "config.json"), "{ not json");
    let error: VeraConfigError | undefined;
    try {
        loadOptionalVeraConfig();
    } catch (caught) {
        error = caught as VeraConfigError;
    }
    const { cards, asked, shown } = presenter(true);

    await recoverConfig(error!, { write: () => {}, confirm: async () => true, cards });

    expect(asked[0]!.body).toEqual([
        "Move the config file aside and start with first-run setup?",
        "The file is kept as a backup beside it.",
        "Once Vera starts, ask it to restore your settings from the backup.",
    ]);
    expect(asked[0]!.choices?.[0]?.label).toBe("move aside and start");
    expect(shown[0]!.title).toBe("Moved the config file aside");
    expect(existsSync(join(home, "config.json"))).toBe(false);
});

test("the long home card names the home, its length and a shorter home", () => {
    const home = "/tmp/vera-dev/a-deliberately-long-home-folder-name-used-to-overflow-the-unix-socket-limit";
    const card = failureCard(new HostSocketPathTooLongError(`${home}/runtime/host.sock`, home, "/tmp/vera"))!;
    const text = renderStartupCard(card, { columns: 64, color: "none" });
    expect(text).toBe([
        "                           V  E  R  A",
        "╭──────────────────────────────────────────────────────────────╮",
        "│ ✗ Vera can't start                                           │",
        "│                                                              │",
        "│   home    /tmp/vera-dev/                                     │",
        "│           a-deliberately-long-home-folder-name-used-to-      │",
        "│           overflow-the-unix-socket-limit                     │",
        `│   reason  the path is ${Buffer.byteLength(home)} characters; on ${socketPlatformName()} a home can be  │`,
        `│           at most ${homeSocketPathLimit()}                                         │`,
        "│                                                              │",
        "│   Start Vera with a shorter home, for example:               │",
        "│                                                              │",
        "│     VERA_HOME=/tmp/vera vera                                 │",
        "│                                                              │",
        "│   Nothing in this home was moved or deleted.                 │",
        "╰──────────────────────────────────────────────────────────────╯",
        "",
    ].join("\n"));
});

test("an unusable home card shows the folder and the reason", () => {
    const card = failureCard(new HostHomeUnusableError("/tmp/x", "is a file, and Vera needs a folder there", "/tmp/vera"))!;
    expect(card.rows).toEqual([
        { label: "folder", value: "/tmp/x" },
        { label: "reason", value: "is a file, and Vera needs a folder there" },
    ]);
    expect(card.body).toContain("Fix that, or start Vera from another home, for example:");
    expect(card.body).toContainEqual({ command: "VERA_HOME=/tmp/vera vera" });
});

test("a boot loop card carries the host's reason as a row", () => {
    const card = failureCard(new HostBootLoopError(2, "port in use"))!;
    expect(card.rows).toEqual([{ label: "reason", value: "port in use" }]);
    expect(card.body?.[0]).toBe("The resident host exited during startup 2 times in a row; not respawning it.");
});

test("other failures have no card and stay plain", () => {
    expect(failureCard(new Error("boom"))).toBeUndefined();
    expect(failureCard("text")).toBeUndefined();
});

test("boot questions default to yes and split the stash question into facts and the ask", () => {
    const stash = bootQuestionCard({
        id: "stash_runtime",
        text: "Vera could not start with its current runtime folder: bad.\nThese processes could not be identified and will be left running:\n  PID 4\nMove the runtime folder to a stash and start fresh?",
    });
    expect(stash.kind).toBe("error");
    expect(stash.body).toEqual([
        "Vera could not start with its current runtime folder: bad.",
        "These processes could not be identified and will be left running:",
        "  PID 4",
        "",
        "Move the runtime folder to a stash and start fresh?",
    ]);
    expect(stash.choices).toEqual([
        { key: "y", label: "stash and start fresh", isDefault: true },
        { key: "n", label: "quit" },
    ]);
    const keep = bootQuestionCard({ id: "keep_fresh_runtime", text: "Keep it?" });
    expect(keep.kind).toBe("question");
    expect(keep.choices?.[0]).toEqual({ key: "y", label: "keep it", isDefault: true });
});

test("the answer hint is dropped from a plain question", () => {
    expect(withoutAnswerHint("Back up and reset? [y/N] ")).toBe("Back up and reset?");
    expect(withoutAnswerHint("No hint here")).toBe("No hint here");
});
