import { expect, test } from "bun:test";
import { registerSourceBrowser } from "../../src/core-extensions/customize/view.ts";
import type { VeraClientExtensionApi, VeraClientPickerRequest } from "../../src/sdk/extensions.ts";
import type { VeraExperimentalTuiDocument } from "../../src/sdk/experimental-tui.ts";

test("preview Escape returns to its list and category through shared surfaces", async () => {
    const requests: VeraClientPickerRequest[] = [];
    const documents: VeraExperimentalTuiDocument[] = [];
    const answers = [
        { outcome: "selected", rowId: "agents", actionId: "open" },
        { outcome: "selected", rowId: "source-0", actionId: "preview" },
        { outcome: "cancelled" }, { outcome: "cancelled" },
    ];
    const api = {
        context: {
            current: () => ({ availability: "unavailable" }),
            sources: async () => ({ warnings: [], sources: [{
                id: "reader", category: "agents", name: "reader", description: "Read notes",
                scope: "project", path: "/project/reader.md", content: "Read notes.",
                contextIds: [], editable: true,
            }] }),
        },
        ui: { requestPicker: async (request: VeraClientPickerRequest) => {
            requests.push(request);
            const answer = answers.shift();
            if (answer === undefined) throw new Error("Unexpected navigation request");
            return answer;
        } },
        experimentalTui: { openDocument: (document: VeraExperimentalTuiDocument) => {
            documents.push(document);
            queueMicrotask(() => document.onClose?.());
        } },
        conversation: { onChanged: () => {} },
    } as unknown as VeraClientExtensionApi;
    await registerSourceBrowser(api).open(new AbortController().signal);
    expect(requests.map((request) => request.title)).toEqual([
        "Customize", "Customize › Agents", "Customize › Agents", "Customize",
    ]);
    expect(requests[1]?.searchable).toBe(true);
    expect(documents[0]?.title).toBe("Customize › Agents › reader");
    expect(documents[0]?.editorPath).toBe("/project/reader.md");
    expect(documents[0]?.markdown).toContain("Source: /project/reader.md");
    expect(documents[0]?.markdown).not.toContain("Read notes.");
    expect(documents[0]?.source).toEqual({ text: "Read notes.", markdown: false });
});

test("a Markdown rule previews rendered with its file as the source", async () => {
    const documents: VeraExperimentalTuiDocument[] = [];
    const answers = [
        { outcome: "selected", rowId: "instructions", actionId: "open" },
        { outcome: "selected", rowId: "source-0", actionId: "preview" },
        { outcome: "cancelled" }, { outcome: "cancelled" },
    ];
    const api = {
        context: {
            current: () => ({ availability: "unavailable" }),
            sources: async () => ({ warnings: [], sources: [{
                id: "instructions:/home/rules/crow.md", category: "instructions", name: "<home>/rules/crow.md",
                description: "User rule, always on", scope: "user", path: "/home/rules/crow.md",
                content: "# Crow rules\n\nHoard buttons.\n", contextIds: [], editable: true,
            }] }),
        },
        ui: { requestPicker: async () => answers.shift() },
        experimentalTui: { openDocument: (document: VeraExperimentalTuiDocument) => {
            documents.push(document);
            queueMicrotask(() => document.onClose?.());
        } },
        conversation: { onChanged: () => {} },
    } as unknown as VeraClientExtensionApi;
    await registerSourceBrowser(api).open(new AbortController().signal);
    expect(documents[0]?.source).toEqual({ text: "# Crow rules\n\nHoard buttons.\n", markdown: true });
});
