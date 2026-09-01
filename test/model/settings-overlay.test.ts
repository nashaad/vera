import { expect, test } from "bun:test";

import {
    joinSettingsOverlay,
    loadShippedSettingsOverlay,
    overlayCatalogLevels,
    overlayDialectForProvider,
} from "../../src/model/settings-overlay.ts";

test("shipped overlay parses", () => {
    const overlay = loadShippedSettingsOverlay();
    expect(overlay?.schema_version).toBe(1);
    expect(overlay?.models.some((row) => row.id === "open/unsloth/qwen3.6-35b-a3b"))
        .toBe(true);
});

test("custom providers are llama.cpp-openai; ollama is ollama; shipped others are none", () => {
    expect(overlayDialectForProvider("unsloth-local")).toBe("llama.cpp-openai");
    expect(overlayDialectForProvider("ollama")).toBe("ollama");
    expect(overlayDialectForProvider("openrouter")).toBeUndefined();
    expect(overlayDialectForProvider("omlx")).toBeUndefined();
});

test("Qwen3.6 on a custom URL joins the Unsloth binary thinking row", () => {
    const row = joinSettingsOverlay({
        provider: "unsloth-local",
        listingId: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    });
    expect(row?.id).toBe("open/unsloth/qwen3.6-35b-a3b");
    expect(row?.thinking.request_layer).toBe("enable-thinking-kwargs");
    const levels = overlayCatalogLevels(row!);
    expect(levels.map((level) => level.id)).toEqual(["high", "off"]);
    expect(levels.find((level) => level.id === "off")?.wire).toBe("false");
    expect(levels.find((level) => level.id === "high")?.label).toBe("Think on");
});

test("the same listing id on Ollama does not get Unsloth kwargs", () => {
    const row = joinSettingsOverlay({
        provider: "ollama",
        listingId: "qwen3.6:latest",
        liveThinking: true,
    });
    expect(row?.id).toBe("open/ollama/qwen3");
    expect(row?.thinking.request_layer).toBe("openai-reasoning-effort");
    expect(row?.thinking.efforts.off).toBe("none");
    expect(row?.thinking.efforts.max).toBe("max");
});

test("Ollama overlay stays silent when /api/show did not list thinking", () => {
    expect(joinSettingsOverlay({
        provider: "ollama",
        listingId: "qwen3:latest",
        liveThinking: false,
    })).toBeUndefined();
});

test("Ollama gpt-oss matches before the thinking fallback and forbids off", () => {
    const row = joinSettingsOverlay({
        provider: "ollama",
        listingId: "gpt-oss:20b",
        liveThinking: true,
    });
    expect(row?.id).toBe("open/ollama/gpt-oss");
    expect(row?.thinking.efforts.off).toBeNull();
});

test("unknown Ollama thinking models use the fallback vocabulary", () => {
    const row = joinSettingsOverlay({
        provider: "ollama",
        listingId: "mystery-reasoner:latest",
        liveThinking: true,
    });
    expect(row?.id).toBe("open/ollama/thinking");
});
