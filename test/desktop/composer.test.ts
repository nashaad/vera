import { describe, expect, test } from "bun:test";

import {
    arrowUpAction,
    enterAction,
    escapeAction,
    folderChoices,
    folderMissingNotice,
    FOLDER_MISSING_TITLE,
    sessionTitle,
} from "../../clients/ui/src/composer/rules.ts";
import { sendPrompt } from "../../clients/ui/src/composer/requests.ts";
import { takePendingPrompt, setPendingPrompt } from "../../clients/ui/src/session/pendingPrompt.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function row(id: string, workspace: string, updatedAt?: number, chat = false): SessionRow {
    return {
        id,
        name: id,
        workspace,
        status: "idle",
        live: false,
        chat,
        ...(updatedAt === undefined ? {} : { updatedAt }),
    };
}

describe("folderChoices", () => {
    test("lists each folder once, most recent session first", () => {
        const choices = folderChoices([
            row("a", "/work/alpha", 10),
            row("b", "/work/beta", 50),
            row("c", "/work/alpha", 90),
        ]);
        expect(choices.map((choice) => choice.folder)).toEqual(["/work/alpha", "/work/beta"]);
    });

    test("names each folder by its last path segment", () => {
        const [choice] = folderChoices([row("a", "/Users/me/Projects/vera/")]);
        expect(choice).toEqual({ folder: "/Users/me/Projects/vera/", name: "vera" });
    });

    test("caps the list at eight folders", () => {
        const rows = Array.from({ length: 12 }, (_, index) => row(`s${index}`, `/w/${index}`, index));
        const choices = folderChoices(rows);
        expect(choices).toHaveLength(8);
        expect(choices[0]?.folder).toBe("/w/11");
    });

    test("skips sessions with no folder", () => {
        expect(folderChoices([row("a", "", 5)])).toEqual([]);
    });

    test("@core skips chats, whose folder is the session's own", () => {
        const choices = folderChoices([
            row("chat", "/home/runtime/sessions/chat.jsonl.files", 99, true),
            row("a", "/work/alpha", 10),
        ]);
        expect(choices.map((choice) => choice.folder)).toEqual(["/work/alpha"]);
    });

    test("@core skips folders that are not known to exist when given the ones that do", () => {
        const rows = [row("a", "/work/gone", 90), row("b", "/work/kept", 50), row("c", "/work/other", 10)];
        expect(folderChoices(rows, 8, new Set(["/work/kept", "/work/other"])).map((choice) => choice.folder))
            .toEqual(["/work/kept", "/work/other"]);
        expect(folderChoices(rows, 8, new Set())).toEqual([]);
    });

    test("the limit counts only the folders that exist", () => {
        const rows = [row("a", "/work/gone", 90), row("b", "/work/kept", 50), row("c", "/work/other", 10)];
        expect(folderChoices(rows, 1, new Set(["/work/kept", "/work/other"])).map((choice) => choice.folder)).toEqual(["/work/kept"]);
    });
});

describe("sessionTitle", () => {
    test("takes the first non-empty line", () => {
        expect(sessionTitle("\n  Fix the build  \nmore")).toBe("Fix the build");
    });

    test("cuts to sixty code points, not UTF-16 units", () => {
        const emoji = "\u{1F600}".repeat(70);
        expect(Array.from(sessionTitle(emoji))).toHaveLength(60);
    });
});

describe("enterAction", () => {
    const idle = { shift: false, composing: false, empty: false, running: false, queued: false };

    test("sends a non-empty box", () => {
        expect(enterAction(idle)).toBe("send");
    });

    test("leaves Shift+Enter and IME confirmation to the textarea", () => {
        expect(enterAction({ ...idle, shift: true })).toBe("passthrough");
        expect(enterAction({ ...idle, composing: true, empty: true, running: true })).toBe("passthrough");
    });

    test("queues a non-empty box while running", () => {
        expect(enterAction({ ...idle, running: true })).toBe("send");
    });

    test("releases every queued prompt on an empty box while running", () => {
        expect(enterAction({ ...idle, empty: true, running: true, queued: true })).toBe("release-all");
    });

    test("aborts the turn on an empty box while running with nothing queued", () => {
        expect(enterAction({ ...idle, empty: true, running: true })).toBe("abort");
    });

    test("swallows Enter on an empty idle box", () => {
        expect(enterAction({ ...idle, empty: true })).toBe("none");
    });
});

describe("escapeAction", () => {
    test("releases the oldest prompt only on an empty box with a queue", () => {
        expect(escapeAction({ composing: false, empty: true, queued: true })).toBe("release-one");
        expect(escapeAction({ composing: false, empty: false, queued: true })).toBe("passthrough");
        expect(escapeAction({ composing: false, empty: true, queued: false })).toBe("passthrough");
        expect(escapeAction({ composing: true, empty: true, queued: true })).toBe("passthrough");
    });
});

describe("sendPrompt", () => {
    test("writes one prompt line and returns the request it sent", () => {
        const lines: string[] = [];
        const sent = sendPrompt((line) => lines.push(line), "hello");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "{}")).toEqual({ type: "prompt", content: "hello", requestId: sent.requestId });
        expect(sent.text).toBe("hello");
    });

    test("gives each prompt a different request id", () => {
        const send = (): void => undefined;
        expect(sendPrompt(send, "a").requestId).not.toBe(sendPrompt(send, "b").requestId);
    });
});

describe("arrow up", () => {
    test("withdraws only from an empty box with a held prompt", () => {
        expect(arrowUpAction({ composing: false, empty: true, held: true })).toBe("withdraw");
        expect(arrowUpAction({ composing: false, empty: false, held: true })).toBe("passthrough");
        expect(arrowUpAction({ composing: false, empty: true, held: false })).toBe("passthrough");
        expect(arrowUpAction({ composing: true, empty: true, held: true })).toBe("passthrough");
    });
});

describe("prompt lines with images", () => {
    test("carry attachment ids only when there are some", () => {
        const lines: string[] = [];
        const sent = sendPrompt((line) => lines.push(line), "look", ["img-1", "img-2"]);
        expect(JSON.parse(lines[0] ?? "{}")).toEqual({
            type: "prompt", content: "look", requestId: sent.requestId, attachmentIds: ["img-1", "img-2"],
        });
        sendPrompt((line) => lines.push(line), "plain", []);
        expect(JSON.parse(lines[1] ?? "{}").attachmentIds).toBeUndefined();
    });
});

describe("pending prompts", () => {
    test("take returns the text once and then nothing", () => {
        setPendingPrompt("agent-1", { text: "first", images: ["/tmp/a.png"] });
        expect(takePendingPrompt("agent-1")).toEqual({ text: "first", images: ["/tmp/a.png"] });
        expect(takePendingPrompt("agent-1")).toBeUndefined();
    });

    test("an unknown agent has no pending prompt", () => {
        expect(takePendingPrompt("never-set")).toBeUndefined();
    });
});

describe("missing folder wording", () => {
    test("the notice names the full path and the chip title says the folder is missing", () => {
        expect(folderMissingNotice("/Users/nash/Projects/gone")).toBe("The folder /Users/nash/Projects/gone no longer exists.");
        expect(FOLDER_MISSING_TITLE).toBe("Folder missing");
    });
});
