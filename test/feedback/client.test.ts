import { expect, test } from "bun:test";
import { activateClient } from "../../extensions/feedback/client.ts";
import type { VeraClientExtensionApi, VeraClientExtensionCommandSpec } from "../../src/sdk/extensions.ts";

test("feedback command collects a report and sends it to the host", async () => {
    let command: VeraClientExtensionCommandSpec | undefined;
    let sent: unknown;
    const entries = ["Crow", "The sail is stuck", "/tmp/crow.png", ""];
    activateClient({
        commands: { register(value: VeraClientExtensionCommandSpec) { command = value; return () => {}; } },
        ui: { async requestPicker() { return { outcome: "selected", rowId: "bug", actionId: "choose" }; } },
        experimentalTui: { async requestSecret() { return entries.shift(); } },
        host: { async request(_name: string, value: unknown) { sent = value; return { path: "/tmp/report" }; } },
    } as unknown as VeraClientExtensionApi);
    expect(command?.name).toBe("feedback");
    const answer = await command!.run({ argumentsText: "", workspace: "/tmp", imageCount: 0, imagePaths: [], signal: new AbortController().signal });
    expect(sent).toEqual({ kind: "bug", title: "Crow", description: "The sail is stuck", source: "terminal", image_paths: ["/tmp/crow.png"] });
    expect(answer).toEqual({ kind: "text", text: "Report saved on this computer: /tmp/report" });
});

test("feedback asks to restart when the host does not have the handler", async () => {
    let command: VeraClientExtensionCommandSpec | undefined;
    const entries = ["Crow", "", ""];
    activateClient({
        commands: { register(value: VeraClientExtensionCommandSpec) { command = value; return () => {}; } },
        ui: { async requestPicker() { return { outcome: "selected", rowId: "bug", actionId: "choose" }; } },
        experimentalTui: { async requestSecret() { return entries.shift(); } },
        host: { async request() { throw new Error("This host cannot run extension requests"); } },
    } as unknown as VeraClientExtensionApi);
    const answer = await command!.run({ argumentsText: "", workspace: "/tmp", imageCount: 0, imagePaths: [], signal: new AbortController().signal });
    expect(answer).toEqual({ kind: "text", text: "Restart Vera and try again." });
});
