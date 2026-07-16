import { Channel, invoke } from "@tauri-apps/api/core";

import type { AgentFrame, ClientFrame } from "../../../src/rpc/frames.ts";
import {
    focusPromptIfReady,
    shouldSendPromptOnKeydown,
} from "./composer.ts";
import { renderAssistantMarkdown } from "./markdown.ts";
import {
    appendPageNotice,
    applyPageFrame,
    beginPageTurn,
    createPageState,
    type PageState,
} from "./state.ts";

interface FrameEvent {
    readonly type: "frame";
    readonly frame: AgentFrame;
}

interface ErrorEvent {
    readonly type: "error";
    readonly message: string;
}

interface ExitedEvent {
    readonly type: "exited";
    readonly code: number | null;
}

interface RenderOptions {
    readonly focusPrompt?: boolean;
}

type RelayEvent = FrameEvent | ErrorEvent | ExitedEvent;

const transcript = element<HTMLElement>("transcript");
const composer = element<HTMLFormElement>("composer");
const prompt = element<HTMLTextAreaElement>("prompt");
const send = element<HTMLButtonElement>("send");
const stop = element<HTMLButtonElement>("stop");
const status = element<HTMLElement>("status");

let state = createPageState();
let connected = false;
let stopRequested = false;
let relayEnded = false;

composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
});

prompt.addEventListener("keydown", (event) => {
    if (shouldSendPromptOnKeydown(event)) {
        event.preventDefault();
        void sendPrompt();
    }
});

stop.addEventListener("click", () => {
    stopRequested = true;
    render();
    void sendFrame({ type: "abort" }).catch(showError);
});

const relay = new Channel<RelayEvent>();
relay.onmessage = (event) => {
    let shouldFocusPrompt = false;
    if (event.type === "frame") {
        state = applyPageFrame(state, event.frame);
        if (event.frame.type === "turn_finished") {
            stopRequested = false;
            shouldFocusPrompt = true;
        }
    } else if (event.type === "error") {
        relayEnded = true;
        showError(event.message);
    } else {
        relayEnded = true;
        connected = false;
        state = appendPageNotice(
            state,
            `Vera exited${event.code === null ? "" : ` with code ${event.code}`}.`,
        );
    }
    render({ focusPrompt: shouldFocusPrompt });
};

void invoke("connect", { onEvent: relay })
    .then(() => {
        connected = !relayEnded;
        render({ focusPrompt: connected });
    })
    .catch((error) => {
        relayEnded = true;
        showError(error);
    });

async function sendPrompt(): Promise<void> {
    const content = prompt.value.trim();
    if (!connected || state.working || content.length === 0) {
        return;
    }

    state = beginPageTurn(state, content);
    prompt.value = "";
    render();

    try {
        await sendFrame({ type: "prompt", content });
    } catch (error) {
        state = { ...state, working: false };
        showError(error);
    }
}

async function sendFrame(frame: ClientFrame): Promise<void> {
    await invoke("send_frame", { frame });
}

function showError(error: unknown): void {
    connected = false;
    const message = error instanceof Error ? error.message : String(error);
    state = appendPageNotice(state, message);
    render();
}

function render(options: RenderOptions = {}): void {
    transcript.replaceChildren(...state.entries.map(renderEntry));
    transcript.scrollTop = transcript.scrollHeight;

    status.textContent = connected
        ? state.working ? "Working" : "Ready"
        : "Disconnected";
    prompt.disabled = !connected || state.working;
    send.disabled = prompt.disabled;
    stop.disabled = !connected || !state.working || stopRequested;

    if (options.focusPrompt) {
        focusPromptIfReady(prompt);
    }
}

function renderEntry(entry: PageState["entries"][number]): HTMLElement {
    const node = document.createElement(
        entry.kind === "assistant" ? "article" : "p",
    );
    node.className = `entry entry-${entry.kind}`;
    if (entry.kind === "assistant") {
        node.innerHTML = renderAssistantMarkdown(entry.text);
    } else {
        node.textContent = entry.text;
    }
    return node;
}

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (value === null) {
        throw new Error(`Missing #${id}`);
    }
    return value as T;
}

render();
