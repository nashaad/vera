import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configuredProviders } from "../../../src/providers/registry.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import type { ExtensionCommandDescriptor, ExtensionCommandResult } from "../../../src/extensions/commands.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import {
    createSettingsAnsweringClient,
} from "../../support/settings-answering-client.ts";
import {
    createTuiResumeScenario,
    IDLE_TARGET_TRANSCRIPT,
} from "../../support/tui-resume-child.ts";
import { searchSessions } from "../../../src/store/session-search.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { HOME_TYPING_HINT } from "../../../clients/tui/home-screen.ts";

const providerEnv = new Map(configuredProviders(undefined).flatMap((provider) =>
    provider.envVar === undefined ? [] : [[provider.envVar, process.env[provider.envVar]] as const]));
for (const key of providerEnv.keys()) delete process.env[key];
afterAll(() => {
    for (const [key, value] of providerEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

interface DeferredExtensionCommandList {
    readonly requested: Promise<void>;
    readonly resolve: (commands: readonly ExtensionCommandDescriptor[]) => void;
    readonly list: () => Promise<readonly ExtensionCommandDescriptor[]>;
}

function deferredExtensionCommandList(): DeferredExtensionCommandList {
    let signalRequested!: () => void;
    let resolve!: (commands: readonly ExtensionCommandDescriptor[]) => void;
    const requested = new Promise<void>((complete) => {
        signalRequested = complete;
    });
    const pending = new Promise<readonly ExtensionCommandDescriptor[]>(
        (complete) => {
            resolve = complete;
        },
    );
    return {
        requested,
        resolve,
        list: async () => {
            signalRequested();
            return pending;
        },
    };
}

function homeDependencies(
    home: string,
    hasSessions: boolean,
    createDelayMs = 0,
    connected = true,
): TuiDependencies {
    const scenario = createTuiResumeScenario({ home });
    return {
        ...scenario.dependencies,
        authStorage: {
            getCredential: (provider) => connected && provider === "openrouter" ? { type: "api_key", key: "fixture" } : undefined,
            setCredential() {}, deleteCredential() {},
        },
        client: createHomeClient("/work/vera"),
        homeHasSessions: hasSessions,
        // The real scan over the transcripts the scenario wrote: home reads
        // what is on disk, and it has no session of its own to read it for.
        searchSessions: (query) => searchSessions(join(home, "sessions"), query),
        createSession: async () => {
            if (createDelayMs > 0) await Bun.sleep(createDelayMs);
            return createSettingsAnsweringClient({
                agentId: "new-session-id",
                model: "new-model",
                mode: "review",
                onCommand: (command, push) => {
                    if (command.type !== "prompt") return;
                    push({
                        type: "user_prompt",
                        content: `SENT ${command.content}`,
                        seq: 1,
                    });
                },
            });
        },
    };
}

test("home paints the card with no composer behind it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        expect(pane).toContain("❯ New conversation");
        expect(pane).toContain("All conversations");
        expect(pane).toContain("Commands");
        expect(pane).toContain("or just start typing");
        // Nothing else is on screen: no composer, and no second invitation
        // from the empty transcript underneath.
        expect(pane).not.toContain("Message Vera");
        expect(pane).not.toContain("Start a conversation with Vera");
        // The status band still says where the next conversation would run.
        expect(pane).toContain("vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("the caret parks one column past the typing hint", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-caret-"));
    const parked: Array<{ x: number; y: number; visible: boolean }> = [];
    const session = await startTuiTestSession({
        home,
        dependencies: (renderer) => {
            const park = renderer.setCursorPosition.bind(renderer);
            renderer.setCursorPosition = (x, y, visible = true) => {
                parked.push({ x, y, visible });
                park(x, y, visible);
            };
            return homeDependencies(home, true);
        },
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        const row = pane.split("\n").findIndex((line) =>
            line.includes(HOME_TYPING_HINT)
        );
        const column = pane.split("\n")[row]!.indexOf(HOME_TYPING_HINT)
            + HOME_TYPING_HINT.length;
        const last = parked[parked.length - 1];
        // One-based, and a space past the hint's last character.
        expect(last).toEqual({ x: column + 2, y: row + 1, visible: true });
    } finally {
        await session.close();
    }
}, 15_000);

test("first run drops the row it has nothing to list for", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-first-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, false),
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        expect(pane).not.toContain("All conversations");
        // With nothing to list, Ctrl+R reaches nothing, and r itself is an
        // ordinary character that starts a conversation carrying it.
        session.sendKey("C-r");
        session.sendText("r");
        const started = await session.waitForVisiblePane(
            "Start a conversation with Vera",
        );
        expect(started).not.toContain("V  E  R  A");
        // The composer holds the character rather than its placeholder.
        expect(started).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("enter on the first row leaves home for a new conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-enter-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Message Vera");
        expect(pane).not.toContain("or just start typing");
    } finally {
        await session.close();
    }
}, 15_000);

test("a machine with no connection leads to the provider list", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-cold-"));
    const session = await startTuiTestSession({
        home,
        providerKey: false,
        dependencies: () => homeDependencies(home, true, 0, false),
    });

    try {
        const card = await session.waitForVisiblePane("Connect a provider");
        expect(card).toContain("❯ Connect a provider");
        // The line that invites a prompt is gone, because there is nowhere to
        // send one yet.
        expect(card).toContain("Vera has no provider yet");
        expect(card).not.toContain(HOME_TYPING_HINT);
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Configure providers");
        expect(pane).toContain("No provider connected");
        expect(pane).toContain("add provider");
    } finally {
        await session.close();
    }
}, 15_000);

test("provider form text fields keep a caret that the arrows move", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-provider-caret-"));
    const session = await startTuiTestSession({
        home,
        providerKey: false,
        dependencies: () => homeDependencies(home, true, 0, false),
    });

    try {
        await session.waitForVisiblePane("Connect a provider");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Configure providers");
        // The first row is a subscription sign-in. An API-key row opens a
        // text form, and Enter on the row opens its actions first.
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Connect");
        session.sendKey("Enter");
        await session.waitForVisiblePane("⏎ save");
        session.sendText("abc");
        await session.waitForVisiblePane("abc");
        session.sendKey("Left");
        await session.settle();
        session.sendText("X");
        const pane = await session.waitForVisiblePane("abXc");
        expect(pane).toContain("⏎ save");
    } finally {
        await session.close();
    }
}, 15_000);

test("new conversation with no provider opens provider configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-cold-new-"));
    const session = await startTuiTestSession({
        home,
        providerKey: false,
        dependencies: () => homeDependencies(home, true, 0, false),
    });

    try {
        await session.waitForVisiblePane("Connect a provider");
        session.sendKey("Down");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Configure providers");
        // The row that would open a conversation with nothing to answer it
        // opens the gates instead.
        expect(pane).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+R opens the session picker from home", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-resume-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-r");
        const pane = await session.waitForVisiblePane(
            "Continue the theme picker",
        );
        expect(pane).toContain("The one already open");
    } finally {
        await session.close();
    }
}, 15_000);

test("the home palette omits commands that need an existing conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-palette-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p");
        const pane = await session.waitForVisiblePane("/themes");
        // No conversation is open, so nothing that would need one is listed,
        // and there is no file behind home to resume.
        expect(pane).not.toContain("Resume this conversation");
        expect(pane).not.toContain("/compact");
        expect(pane).not.toContain("/rewind");
    } finally {
        await session.close();
    }
}, 15_000);

test("typing carries the first character into the new conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-typing-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("h");
        const pane = await session.waitForVisiblePane(
            "Start a conversation with Vera",
        );
        expect(pane).not.toContain("V  E  R  A");
        expect(pane).not.toContain("Message Vera");
        session.sendText("ello");
        const typed = await session.waitForVisiblePane("hello");
        expect(typed).toContain("hello");
    } finally {
        await session.close();
    }
}, 15_000);

test("@core home lists extension commands and runs one in the created conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-extension-command-"));
    const listed: readonly ExtensionCommandDescriptor[] = [{
        name: "budget",
        description: "Set a conversation budget",
        usage: "/budget [amount]",
        source: "vera.budget",
    }];
    const calls: Array<{ command: string; argumentsText: string }> = [];
    let created = 0;
    let attachedListCalls = 0;
    let markAttachedListStarted!: () => void;
    let releaseAttachedList!: (
        commands: readonly ExtensionCommandDescriptor[],
    ) => void;
    const attachedListStarted = new Promise<void>((resolve) => {
        markAttachedListStarted = resolve;
    });
    const attachedList = new Promise<readonly ExtensionCommandDescriptor[]>(
        (resolve) => {
            releaseAttachedList = resolve;
        },
    );
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: async () => listed,
            }),
            createSession: async () => {
                created += 1;
                return Object.assign(createSettingsAnsweringClient({
                    agentId: "extension-command-session",
                    model: "new-model",
                    mode: "review",
                }), {
                    listExtensionCommands: async () => {
                        attachedListCalls += 1;
                        markAttachedListStarted();
                        return attachedList;
                    },
                    runExtensionCommand: async (command: string, argumentsText: string): Promise<ExtensionCommandResult> => {
                        calls.push({ command, argumentsText });
                        return {
                            version: 1,
                            source: "vera.budget",
                            body: { kind: "text", text: "Budget changed to $5.00" },
                        };
                    },
                });
            },
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/bud");
        const suggestions = await session.waitForVisiblePane("/budget");
        expect(suggestions).toContain("Set a conversation budget");
        session.sendKey("Escape");
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p");
        session.sendText("budget");
        const palette = await session.waitForVisiblePane("/budget");
        expect(palette).toContain("Set a conversation budget");
        session.sendKey("Escape");
        await session.waitForVisiblePane("V  E  R  A");

        session.sendText("/budget 5");
        session.sendKey("Enter");
        await attachedListStarted;
        session.sendText(" keep this draft");
        await session.settle();
        expect(attachedListCalls).toBe(1);
        expect(calls).toEqual([]);
        releaseAttachedList(listed);
        const result = await session.waitForVisiblePane("Budget changed to $5.00");
        expect(result).toContain("keep this draft");
        expect(created).toBe(1);
        expect(calls).toEqual([{ command: "budget", argumentsText: "5" }]);
    } finally {
        await session.close();
    }
}, 15_000);

test("@core an unknown extension-command typo on home does not create a conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-unknown-extension-command-"));
    let created = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: async () => [{
                    name: "budget",
                    description: "Set a conversation budget",
                    usage: "/budget [amount]",
                    source: "vera.budget",
                }],
            }),
            createSession: async () => {
                created += 1;
                return createSettingsAnsweringClient({
                    agentId: "unexpected-session",
                    model: "new-model",
                });
            },
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/budegt");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Unknown command: /budegt");
        expect(pane).toContain("Did you mean /budget?");
        expect(created).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("@core home holds a slash command until the initial host list succeeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-pending-command-list-"));
    const budget: ExtensionCommandDescriptor = {
        name: "budget",
        description: "Set a conversation budget",
        usage: "/budget [amount]",
        source: "vera.budget",
    };
    const deferred = deferredExtensionCommandList();
    let created = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: deferred.list,
            }),
            createSession: async () => {
                created += 1;
                return Object.assign(createSettingsAnsweringClient({
                    agentId: "pending-home-command-session",
                    model: "new-model",
                }), {
                    listExtensionCommands: async () => [budget],
                    runExtensionCommand: async (): Promise<ExtensionCommandResult> => ({
                        version: 1,
                        source: budget.source,
                        body: { kind: "text", text: "Budget changed to $5.00" },
                    }),
                });
            },
        }),
    });

    try {
        await deferred.requested;
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/budget 5");
        session.sendKey("Enter");
        await session.settle();
        expect(created).toBe(0);
        const waitingPane = await session.waitForVisiblePane("/budget 5");
        expect(waitingPane).not.toContain("Unknown command: /budget");
        deferred.resolve([budget]);
        const pane = await session.waitForVisiblePane("Budget changed to $5.00");
        expect(pane).toContain("Budget changed to $5.00");
        expect(created).toBe(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("home resolves a pending typo only after host commands load", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-pending-typo-"));
    const deferred = deferredExtensionCommandList();
    let created = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: deferred.list,
            }),
            createSession: async () => {
                created += 1;
                return createSettingsAnsweringClient({
                    agentId: "unexpected-pending-typo-session",
                    model: "new-model",
                });
            },
        }),
    });

    try {
        await deferred.requested;
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/budegt");
        session.sendKey("Enter");
        await session.settle();
        expect(created).toBe(0);
        deferred.resolve([{
            name: "budget",
            description: "Set a conversation budget",
            usage: "/budget [amount]",
            source: "vera.budget",
        }]);
        const pane = await session.waitForVisiblePane("Unknown command: /budegt");
        expect(pane).toContain("Did you mean /budget?");
        expect(created).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("a failed Home list is reported and retried on slash submission", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-list-retry-"));
    const budget: ExtensionCommandDescriptor = {
        name: "budget",
        description: "Set a conversation budget",
        usage: "/budget [amount]",
        source: "vera.budget",
    };
    let listCalls = 0;
    let created = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: async () => {
                    listCalls += 1;
                    if (listCalls === 1) {
                        throw new Error("catalog unavailable");
                    }
                    return [budget];
                },
            }),
            createSession: async () => {
                created += 1;
                return Object.assign(createSettingsAnsweringClient({
                    agentId: "retried-home-command-session",
                    model: "new-model",
                }), {
                    listExtensionCommands: async () => [budget],
                    runExtensionCommand: async (): Promise<ExtensionCommandResult> => ({
                        version: 1,
                        source: budget.source,
                        body: { kind: "text", text: "Budget changed to $5.00" },
                    }),
                });
            },
        }),
    });

    try {
        const failed = await session.waitForVisiblePane(
            "Could not load extension commands: catalog unavailable",
        );
        expect(failed).toContain("Could not load extension commands: catalog unavailable");
        session.sendText("/budget 5");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Budget changed to $5.00");
        expect(pane).not.toContain("Unknown command: /budget");
        expect(listCalls).toBe(2);
        expect(created).toBe(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("a path submitted on home bypasses pending command discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-pending-path-"));
    const deferred = deferredExtensionCommandList();
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...homeDependencies(home, true),
            client: createHomeClient("/work/vera", {
                listExtensionCommands: deferred.list,
            }),
        }),
    });

    try {
        await deferred.requested;
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/tmp/report.txt");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("SENT /tmp/report.txt");
        expect(pane).not.toContain("Unknown command: /tmp");
        deferred.resolve([]);
    } finally {
        deferred.resolve([]);
        await session.close();
    }
}, 15_000);

test("a sentence typed on home arrives whole", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-sentence-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true, 300),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        // The composer does not exist for most of this: the rest of the
        // sentence would be dropped if home stopped collecting at the first
        // character.
        session.sendText("check the tests");
        const pane = await session.waitForVisiblePane("heck the tests");
        expect(pane).not.toContain("V  E  R  A");
    } finally {
        await session.close();
    }
}, 15_000);

test("enter sent before the composer exists still sends the message", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-early-enter-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true, 300),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        // Both the sentence and the Enter that ends it land while the
        // conversation is still being created.
        session.sendText("send this");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("SENT send this");
        expect(pane).not.toContain("V  E  R  A");
    } finally {
        await session.close();
    }
}, 15_000);

test("the home palette has no command for starting over", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-clear-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p");
        const pane = await session.waitForVisiblePane("/themes");
        // There is no conversation to clear or to keep running, and the card
        // already has a row for starting one.
        expect(pane).not.toContain("/clear");
        expect(pane).not.toContain("/fresh");
    } finally {
        await session.close();
    }
}, 15_000);

test("the picker opened from home leaves nothing behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-picker-footer-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-r");
        const pane = await session.waitForVisiblePane("⏎ open");
        expect(pane).not.toContain("stop & switch");
        expect(pane).not.toContain("keep running");
    } finally {
        await session.close();
    }
}, 15_000);

test("ctrl+e from home opens resume instead of a side rail", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-rail-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-e");
        const pane = await session.waitForVisiblePane("Continue the theme picker");
        expect(pane).toContain("Resume");
        expect(pane).not.toContain("Chat    →");
        session.sendKey("Escape");
        await session.waitForVisiblePane("V  E  R  A");
    } finally {
        await session.close();
    }
}, 15_000);

test("escape from the resume ctrl+e opened returns to the home card", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-rail-focus-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane(HOME_TYPING_HINT);
        session.sendKey("C-e");
        await session.waitForVisiblePane("Resume");
        session.sendKey("Escape");
        const pane = await session.waitForVisiblePane(HOME_TYPING_HINT);
        expect(pane).toContain("V  E  R  A");
        expect(pane).not.toContain("Resume");
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+F searches the transcripts without opening a session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-search-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("Search past work");
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search · this workspace");
        session.sendText("transcript");
        // The hit comes from the seeded session file, so the scan is the real
        // one over real transcripts rather than a stubbed answer.
        const pane = await session.waitForVisiblePane(IDLE_TARGET_TRANSCRIPT);
        expect(pane).not.toContain("Message Vera");
        session.sendKey("Escape");
        const card = await session.waitForVisiblePane("V  E  R  A");
        // Back on the card, and still no conversation: searching costs no
        // worker, the same as landing on home does.
        expect(card).toContain("Search past work");
        expect(card).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);
