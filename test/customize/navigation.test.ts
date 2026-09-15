import { expect, test } from "bun:test";
import { registerSourceBrowser } from "../../extensions/customize/view.ts";
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
    expect(documents[0]?.markdown).toContain("Read notes.");
});
