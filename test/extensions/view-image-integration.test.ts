import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { projectTranscript } from "../../src/engine/protocol.ts";
import { entriesToBlocks } from "../../clients/ui/src/session/transcript.ts";
import {
    decideToolPermission,
    extractPermissionActions,
    type PermissionMode,
} from "../../src/engine/permissions.ts";
import { includedExtensions } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import {
    ImageAttachmentService,
    hydrateImageAttachments,
    OMITTED_IMAGE_TEXT,
} from "../../src/attachments/service.ts";
import { IMAGE_ATTACHMENT_LIMITS } from "../../src/attachments/image.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sharp = (await import("sharp")).default;
const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#2563eb" },
}).png().toBuffer();

function imageExtensionPath(): string {
    const entry = includedExtensions().find((extension) => extension.id === "vera.view-image");
    if (entry === undefined) throw new Error("Included vera.view-image extension is unavailable");
    return entry.path;
}

function permissionMode(
    name: string,
    tool: string,
    verb: string | undefined,
    then: "allow" | "ask" | "deny",
): PermissionMode {
    return {
        name,
        rules: [{
            name: `${name}-view-image`,
            when: {
                tool,
                ...(verb === undefined ? {} : { verb }),
            },
            then,
        }],
        defaultOutcome: "allow",
    } as PermissionMode;
}

for (const { vision, removeBeforeAttachment } of [
    { vision: true, removeBeforeAttachment: false },
    { vision: false, removeBeforeAttachment: false },
    { vision: true, removeBeforeAttachment: true },
]) {
    test(`@core view_image flows through the engine with vision=${vision}, removed=${removeBeforeAttachment}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-view-image-"));
        roots.push(root);
        const imagePath = join(root, "source.png");
        writeFileSync(imagePath, png);
        const extensionPath = imageExtensionPath();
        if (!existsSync(extensionPath)) throw new Error(`Missing included extension at ${extensionPath}`);

        const failures: string[] = [];
        const registry = await startExtensionRegistry({
            extensions: [{ path: extensionPath, enabled: true, config: {} }],
            onFailure: (failure) => failures.push(failure.message),
        });
        const runtime = new ToolRuntime(root);
        try {
            expect(failures).toEqual([]);
            const tool = registry.tools().find((entry) => entry.definition.name === "view_image");
            expect(tool).toBeDefined();
            expect(tool!.definition.inputSchema).toMatchObject({
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            });
            expect(tool!.permissionOperation).toBeUndefined();

            const sessionPath = join(root, "session.jsonl");
            const store = await SessionStore.create(sessionPath, {
                sessionId: "view-image",
                cwd: root,
            });
            const service = new ImageAttachmentService(store, IMAGE_ATTACHMENT_LIMITS);
            const response = (
                content: AssistantMessage["content"],
                stopReason: AssistantMessage["stopReason"],
            ): AssistantMessage => ({
                role: "assistant",
                content,
                stopReason,
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
            });
            const faux = new FauxAdapter([
                response([{
                    type: "tool_call",
                    id: "view-image-1",
                    name: "view_image",
                    input: { path: imagePath },
                }], "tool_use"),
                response([{ type: "text", text: "Image inspected" }], "stop"),
            ]);
            const requests: ModelRequest[] = [];
            const adapter: ModelAdapter = {
                imageInputSupport: () => vision,
                stream: (request) => {
                    requests.push(request);
                    return faux.stream(request);
                },
            };
            const channel = createInProcessChannel();
            const events = new EngineEventBus();
            let reviews = 0;
            const state: RunTurnState = {
                messages: [],
                store,
                events,
                toolRuntime: runtime,
                inbound: new InboundCommandRouter(channel.engine, events),
                hooks: new ToolHooks(),
                approvalMode: "auto",
                extensionTools: registry.tools(),
                reviewToolCall: async () => {
                    reviews += 1;
                    return {
                        decision: "allow",
                        reason: "Read the requested image",
                        riskLevel: "low",
                        userAuthorization: "high",
                    };
                },
                attachToolImage: async (path, signal) => {
                    if (removeBeforeAttachment) rmSync(path);
                    return (await service.attachFile(path, signal)).id;
                },
                readImageContent: (id) => service.readContent(id),
            };

            channel.client.send({ type: "prompt", content: "Inspect the picture" });
            await runTurn(adapter, "test", state);

            expect(requests).toHaveLength(2);
            expect(reviews).toBe(0);
            const output = `source.png: PNG, 2x2, ${png.length} bytes`;
            const result = requests[1]!.messages.find((message) => message.role === "tool_result");
            expect(result).toMatchObject({
                isError: false,
                content: [{ type: "text", text: output }],
            });
            const delivered = requests[1]!.messages.filter(
                (message) => message.role === "user" && message.internal,
            );
            expect(delivered).toHaveLength(1);
            const serialized = JSON.stringify(delivered);
            expect(serialized.includes('"type":"image"')).toBe(vision && !removeBeforeAttachment);
            expect(serialized.includes(OMITTED_IMAGE_TEXT)).toBe(!vision && !removeBeforeAttachment);
            expect(serialized.includes("Image unavailable:")).toBe(removeBeforeAttachment);
            expect(serialized).not.toContain("imagePaths");

            expect(store.attachmentRecords()).toHaveLength(removeBeforeAttachment ? 0 : 1);
            if (existsSync(imagePath)) rmSync(imagePath);
            const reopened = await SessionStore.open(sessionPath);
            for (const session of [store, reopened]) {
                const transcript = projectTranscript(session.messages());
                const toolEntries = transcript.filter((entry) => entry.kind === "tool" || entry.kind === "tool_result");
                expect(toolEntries).toMatchObject([
                    { kind: "tool", tool: "view_image", args: { path: imagePath } },
                    { kind: "tool_result", tool: "view_image", output, isError: false },
                ]);
                expect(JSON.stringify(transcript)).not.toContain("image_attachment");
                expect(entriesToBlocks(toolEntries)).toMatchObject([{
                    kind: "tools",
                    calls: [{ tool: "view_image", title: "view_image source.png", state: "done", output }],
                }]);
            }
            const replay = await hydrateImageAttachments(
                state.messages,
                (id) => new ImageAttachmentService(reopened, IMAGE_ATTACHMENT_LIMITS).readContent(id),
            );
            const replayedImages = replay.flatMap((message) =>
                message.role === "user" ? message.content.filter((block) => block.type === "image") : [],
            );
            expect(replayedImages).toHaveLength(removeBeforeAttachment ? 0 : 1);
            if (!removeBeforeAttachment) {
                expect(replayedImages[0]).toMatchObject({
                    mediaType: "image/png",
                    data: new Uint8Array(png),
                });
            }
        } finally {
            await runtime.close();
            await registry.close();
        }
    });
}

test("@core view_image registration exposes read-path permissions to policy evaluation", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-view-image-permissions-"));
    roots.push(root);
    const registry = await startExtensionRegistry({
        extensions: [{ path: imageExtensionPath(), enabled: true, config: {} }],
    });
    try {
        const tools = registry.tools();
        const call = {
            id: "view-image-permission",
            name: "view_image",
            input: { path: "../outside/source.png" },
        };
        expect(extractPermissionActions({
            toolCall: call,
            workspace: root,
            homeDirectory: root,
        }, tools)).toEqual([{
            tool: "view_image",
            verb: "read",
            path: join(root, "..", "outside", "source.png"),
            scope: "outside_workspace",
        }]);

        for (const outcome of ["deny", "ask"] as const) {
            const mode = permissionMode(`view-image-${outcome}`, "view_image", "read", outcome);
            expect(decideToolPermission(mode.name, call, root, [], {
                homeDirectory: root,
                extensionTools: tools,
                permissionModes: { [mode.name]: mode },
            }).behavior).toBe(outcome);
        }

        const unrelatedReadRule = permissionMode("named-read", "read", undefined, "deny");
        expect(decideToolPermission(unrelatedReadRule.name, call, root, [], {
            homeDirectory: root,
            extensionTools: tools,
            permissionModes: { [unrelatedReadRule.name]: unrelatedReadRule },
        }).behavior).toBe("allow");

        for (const mode of ["readonly", "ask", "auto", "full_access"] as const) {
            for (const path of ["source.png", "../outside/source.png"]) {
                expect(decideToolPermission(mode, {
                    ...call,
                    input: { path },
                }, root, [], { homeDirectory: root, extensionTools: tools }).behavior).toBe("allow");
            }
        }

        const privateCall = { ...call, input: { path: join(root, ".aws", "image.png") } };
        const privateDeny = [{ name: "private", when: { verb: "read" as const, path: "~/.aws" }, then: "deny" as const }];
        for (const mode of ["readonly", "ask", "auto", "full_access"] as const) {
            expect(decideToolPermission(mode, privateCall, root, [], {
                homeDirectory: root, extensionTools: tools, permissionRules: privateDeny,
            }).behavior).toBe("deny");
        }
        for (const mode of ["ask", "auto"] as const) {
            const rules = [{ ...privateDeny[0]!, then: "ask" as const }];
            const decision = decideToolPermission(mode, privateCall, root, [], {
                homeDirectory: root, extensionTools: tools, permissionRules: rules,
            });
            expect(decision.behavior).toBe("ask");
            expect(decision.actions[0]).toMatchObject({ rule: "private", liftable: false });
            expect(decideToolPermission(mode, privateCall, root, [], {
                homeDirectory: root,
                extensionTools: tools,
                permissionRules: [{ ...privateDeny[0]!, when: { ...privateDeny[0]!.when, tool: "read" } }],
            }).behavior).toBe("allow");
            expect(decideToolPermission(mode, { ...call, input: { path: ".env" } }, root, [], {
                homeDirectory: root, extensionTools: tools,
            }).behavior).toBe("deny");
        }
    } finally {
        await registry.close();
    }
});
