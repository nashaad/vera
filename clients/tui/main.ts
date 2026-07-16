import {
    BoxRenderable,
    CliRenderEvents,
    MarkdownRenderable,
    ScrollBoxRenderable,
    SyntaxStyle,
    TextareaRenderable,
    TextRenderable,
    createCliRenderer,
    type Selection,
} from "@opentui/core";

import { loadVeraConfig } from "../../src/config.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { createInstanceDirectory } from "../../src/instances/directory.ts";
import { createOpenRouterAdapter } from "../../src/model/openrouter.ts";
import { createInProcessChannel } from "../../src/rpc/in-process-channel.ts";
import { copyTuiText, countTuiCharacters } from "./clipboard.ts";
import { isTranscriptSelection } from "./selection.ts";
import {
    TUI_ACCENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_TEXT,
    appendTuiNotice,
    applyAgentFrame,
    beginTuiTurn,
    createTuiState,
    renderTuiEntry,
    tuiEntryMarginTop,
} from "./state.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
const { model } = loadVeraConfig();

if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
}

const READY_HINT = "enter send · shift+enter newline · ctrl+c quit";
const WORKING_HINT = "working…";
const COPY_NOTICE_DURATION_MS = 1_500;

const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
});
renderer.setTerminalTitle("Vera");

const channel = createInProcessChannel();
const adapter = createOpenRouterAdapter({ apiKey });
let state = createTuiState();
let statusNotice: string | undefined;
let statusNoticeVersion = 0;
let shuttingDown = false;

const markdownStyle = SyntaxStyle.fromStyles({
    default: { fg: TUI_TEXT },
    "markup.heading": { fg: TUI_ACCENT, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: "#9ECE6A" },
    "markup.raw.block": { fg: "#9ECE6A" },
    "markup.list": { fg: TUI_ACCENT },
    "markup.quote": { fg: TUI_MUTED, italic: true },
    "markup.link": { fg: TUI_ACCENT, underline: true },
    "markup.link.label": { fg: TUI_ACCENT },
    "markup.link.url": { fg: TUI_MUTED, underline: true },
    conceal: { fg: TUI_MUTED },
});

const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    width: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    contentOptions: {
        flexDirection: "column",
        gap: 0,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
    },
});

const placeholder = new TextRenderable(renderer, {
    id: "placeholder",
    content: "Start a conversation with Vera.",
    fg: TUI_MUTED,
    width: "100%",
});
transcript.add(placeholder);

const entryNodes: (TextRenderable | MarkdownRenderable)[] = [];

const statusText = new TextRenderable(renderer, {
    id: "status",
    content: READY_HINT,
    fg: "#565B66",
    width: "100%",
    height: 1,
    paddingLeft: 2,
});

const composer = new TextareaRenderable(renderer, {
    id: "composer",
    width: "100%",
    height: 3,
    placeholder: "Message Vera…",
    backgroundColor: "#16161E",
    focusedBackgroundColor: "#16161E",
    textColor: "#F0F0F0",
    focusedTextColor: "#FFFFFF",
    cursorColor: "#7AA2F7",
    keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
    ],
    onSubmit: () => {
        void submitPrompt();
    },
});

const composerBox = new BoxRenderable(renderer, {
    id: "composer-box",
    border: ["left"],
    borderStyle: "heavy",
    borderColor: "#7AA2F7",
    backgroundColor: "#16161E",
    width: "100%",
    height: 3,
    paddingX: 1,
});
composerBox.add(composer);

const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
    paddingTop: 1,
    paddingBottom: 0,
});
app.add(transcript);
app.add(composerBox);
app.add(statusText);
renderer.root.add(app);
composer.focus();

const presence = createInstanceDirectory().register({
    client: "tui",
    workspacePath: process.cwd(),
});

renderer.on(CliRenderEvents.DESTROY, () => {
    shuttingDown = true;
    presence.remove();
});

renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
    if (isTranscriptSelection(selection, entryNodes)) {
        void copyTranscriptSelection(selection);
    }
});

void runHeadlessLoop(channel.engine, adapter, model).catch((error: unknown) => {
    if (shuttingDown) {
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    state = appendTuiNotice(state, `Engine error: ${message}`);
    renderState();
});

async function submitPrompt(): Promise<void> {
    if (state.working) {
        return;
    }

    const prompt = composer.plainText.trim();
    if (prompt.length === 0) {
        return;
    }

    composer.setText("");
    composer.blur();
    state = beginTuiTurn(state, prompt);
    renderState();
    channel.client.send({ type: "prompt", content: prompt });

    while (true) {
        const frame = await channel.client.receive();
        if (shuttingDown) {
            return;
        }
        state = applyAgentFrame(state, frame);
        renderState();

        if (frame.type === "turn_finished") {
            composer.focus();
            return;
        }
    }
}

function renderState(): void {
    if (shuttingDown) {
        return;
    }

    placeholder.visible = state.entries.length === 0;

    state.entries.forEach((entry, index) => {
        const existing = entryNodes[index];
        if (existing) {
            if (
                existing instanceof MarkdownRenderable &&
                existing.content !== entry.text
            ) {
                existing.content = entry.text;
            }
            return;
        }

        const marginTop = tuiEntryMarginTop(state.entries, index);
        const node = entry.kind === "assistant"
            ? new MarkdownRenderable(renderer, {
                id: `entry-${index}`,
                content: entry.text,
                syntaxStyle: markdownStyle,
                fg: TUI_TEXT,
                streaming: true,
                width: "100%",
                marginTop,
            })
            : new TextRenderable(renderer, {
                id: `entry-${index}`,
                content: renderTuiEntry(entry),
                width: "100%",
                wrapMode: "word",
                selectable: true,
                marginTop,
            });
        entryNodes.push(node);
        transcript.add(node);
    });

    if (!state.working) {
        const lastNode = entryNodes.at(-1);
        if (lastNode instanceof MarkdownRenderable) {
            lastNode.streaming = false;
        }
    }

    renderStatus();
}

async function copyTranscriptSelection(selection: Selection): Promise<void> {
    const text = selection.getSelectedText();
    if (text.length === 0) {
        return;
    }

    try {
        await copyTuiText(text, renderer);
        if (shuttingDown) {
            return;
        }
        if (renderer.getSelection() === selection) {
            renderer.clearSelection();
        }
        const count = countTuiCharacters(text);
        showStatusNotice(`copied ${count} character${count === 1 ? "" : "s"}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatusNotice(`copy failed · ${message}`);
    }
}

function showStatusNotice(message: string): void {
    statusNotice = message;
    statusNoticeVersion += 1;
    const version = statusNoticeVersion;
    renderStatus();

    setTimeout(() => {
        if (statusNoticeVersion !== version) {
            return;
        }
        statusNotice = undefined;
        renderStatus();
    }, COPY_NOTICE_DURATION_MS);
}

function renderStatus(): void {
    if (shuttingDown) {
        return;
    }

    statusText.fg = statusNotice === undefined ? "#565B66" : TUI_NOTICE;
    statusText.content = statusNotice
        ?? (state.working ? WORKING_HINT : READY_HINT);
}
