import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ImageAttachmentService, hydrateImageAttachments, OMITTED_IMAGE_TEXT } from "../../src/attachments/service.ts";
import { IMAGE_ATTACHMENT_LIMITS } from "../../src/attachments/image.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sharp = (await import("sharp")).default;
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#2563eb" } }).png().toBuffer();

for (const vision of [true, false]) {
    test(`extension tool images survive session replay; vision=${vision}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-tool-images-")); roots.push(root);
        const path = join(root, "capture.png"); writeFileSync(path, png);
        writeFileSync(join(root, "vera.extension.json"), JSON.stringify({ id: "test.images", version: "1", sdk: "1", entrypoint: "./extension.ts", capabilities: ["tools.register"] }));
        writeFileSync(join(root, "extension.ts"), `export function activate(vera) {
            vera.tools.register({ name: 'capture_test', description: 'Capture an image', inputSchema: { type: 'object', properties: {} },
                run: () => ({ output: 'Captured image', imagePaths: [${JSON.stringify(path)}] }) });
        }`);
        const registry = await startExtensionRegistry({ extensions: [{ path: root, enabled: true, config: {} }] });
        try {
            expect(registry.tools()).toHaveLength(1);
            const sessionPath = join(root, "session.jsonl");
            const store = await SessionStore.create(sessionPath, { sessionId: "images", cwd: root });
            const service = new ImageAttachmentService(store, IMAGE_ATTACHMENT_LIMITS);
            const response = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
                role: "assistant", content, stopReason, source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(),
            });
            const faux = new FauxAdapter([
                response([{ type: "tool_call", id: "capture-1", name: "capture_test", input: {} }, { type: "tool_call", id: "capture-2", name: "capture_test", input: {} }], "tool_use"),
                response([{ type: "text", text: "Done" }], "stop"),
            ]);
            const requests: ModelRequest[] = [];
            const adapter: ModelAdapter = { imageInputSupport: () => vision, stream: request => { requests.push(request); return faux.stream(request); } };
            const channel = createInProcessChannel();
            const events = new EngineEventBus();
            const state: RunTurnState = {
                messages: [], store, events, toolRuntime: new ToolRuntime(root),
                inbound: new InboundCommandRouter(channel.engine, events), hooks: new ToolHooks(), approvalMode: "auto",
                extensionTools: registry.tools(),
                reviewToolCall: async () => ({ decision: "allow", reason: "Read the generated test image", riskLevel: "low", userAuthorization: "high" }),
                attachToolImage: async (path, signal) => (await service.attachFile(path, signal)).id,
                readImageContent: id => service.readContent(id),
            };
            channel.client.send({ type: "prompt", content: "capture twice" });
            await runTurn(adapter, "test", state);
            expect(requests).toHaveLength(2);
            const messages = requests[1]!.messages;
            expect(messages.slice(1, 4).map(message => message.role)).toEqual(["assistant", "tool_result", "tool_result"]);
            for (const message of messages) if (message.role === "tool_result") expect(message.isError, JSON.stringify(message.content)).toBe(false);
            const imageMessages = messages.filter(message => message.role === "user" && message.internal);
            expect(imageMessages).toHaveLength(2);
            const serialized = JSON.stringify(imageMessages);
            expect(serialized.includes('"type":"image"'), serialized).toBe(vision);
            expect(serialized.includes(OMITTED_IMAGE_TEXT)).toBe(!vision);
            expect(serialized).not.toContain('"imagePaths"');
            const reopened = await SessionStore.open(sessionPath);
            expect(reopened.attachmentRecords()).toHaveLength(1);
            const replay = await hydrateImageAttachments(state.messages, id => new ImageAttachmentService(reopened, IMAGE_ATTACHMENT_LIMITS).readContent(id));
            const image = replay.flatMap(message => message.role === "user" ? message.content.filter(block => block.type === "image") : []);
            expect(image).toHaveLength(2);
            expect(image[0]).toMatchObject({ mediaType: "image/png", data: new Uint8Array(png) });
        } finally { await registry.close(); }
    });
}
