import { expect, test } from "bun:test";

import { resolveTuiSettingsDestination } from "../../clients/tui/settings-destination.ts";

test("the TUI maps semantic settings to native routes", () => {
    expect(resolveTuiSettingsDestination({ kind: "model" })).toEqual({
        status: "resolved",
        destination: { kind: "model" },
        route: { type: "model_picker" },
    });
    expect(resolveTuiSettingsDestination({
        kind: "provider",
        provider: "openrouter",
    })).toEqual({
        status: "resolved",
        destination: { kind: "provider", provider: "openrouter" },
        route: { type: "provider_picker", provider: "openrouter" },
    });
    expect(resolveTuiSettingsDestination({
        kind: "model_assignment",
        assignment: "compaction",
    })).toEqual({
        status: "resolved",
        destination: { kind: "model_assignment", assignment: "compaction" },
        route: { type: "model_assignment", assignment: "compaction" },
    });
    expect(resolveTuiSettingsDestination(
        { kind: "permission_mode", mode: "careful" },
        { permissionModes: ["ask", "careful"] },
    )).toEqual({
        status: "resolved",
        destination: { kind: "permission_mode", mode: "careful" },
        route: { type: "permission_mode_picker", mode: "careful" },
    });
});

test("the TUI reports unsupported destinations explicitly", () => {
    expect(resolveTuiSettingsDestination({ kind: "old_settings_screen" }))
        .toEqual({ status: "unsupported" });
    expect(resolveTuiSettingsDestination({ kind: "model", focus: "search" }))
        .toEqual({ status: "unsupported" });
    expect(resolveTuiSettingsDestination(
        { kind: "permission_mode", mode: "retired-mode" },
        { permissionModes: ["ask"] },
    )).toEqual({ status: "unsupported" });
    expect(resolveTuiSettingsDestination({
        kind: "permission_mode",
        mode: "unverified-custom-mode",
    })).toEqual({ status: "unsupported" });
});
