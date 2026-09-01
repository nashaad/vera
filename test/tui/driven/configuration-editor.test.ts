import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("configure chooses the profile config and reports when its editor closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-config-editor-"));
    let editorOpenings = 0;
    let openedPath: string | undefined;
    let closeEditor: (() => void) | undefined;
    const editorClosed = new Promise<void>((resolve) => {
        closeEditor = resolve;
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiChildDependencies(),
            openConfigurationFile: async (path) => {
                editorOpenings += 1;
                openedPath = path;
                await editorClosed;
            },
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("configure files");
        const palette = await session.waitForVisiblePane("Configure files");
        expect(palette.replace(/\s+/g, " ")).toContain(
            "choose a profile or project config file to edit",
        );
        session.sendKey("Enter");
        const picker = await session.waitForVisiblePane(
            "Choose a configuration file to edit",
        );
        expect(picker).toContain(
            "These files are the daily Vera home.",
        );
        expect(picker).toContain("Profile config");
        expect(picker).not.toContain("TUI preferences");
        expect(picker).not.toContain("Project config");
        session.sendKey("Enter");
        await session.settle(100);
        expect(editorOpenings).toBe(1);
        expect(openedPath?.endsWith("/config.json")).toBe(true);
        expect(session.captureVisiblePane()).not.toContain(
            "Profile config editor closed:",
        );
        closeEditor!();

        const pane = await session.waitForVisiblePane(
            "Profile config editor closed:",
        );
        expect(pane).toContain("config.json");
    } finally {
        closeEditor?.();
        await session.close();
    }
}, 15_000);

test("configure lists existing optional files and refuses one removed before Enter", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-config-files-"));
    const profile = join(home, ".vera");
    const tuiPreferences = join(profile, "tui.json");
    const workspace = join(home, "workspace");
    const projectConfig = join(workspace, ".vera", "config.json");
    mkdirSync(profile, { recursive: true });
    mkdirSync(join(workspace, ".vera"), { recursive: true });
    writeFileSync(tuiPreferences, "{}\n");
    writeFileSync(projectConfig, "{}\n");
    const openedPaths: string[] = [];
    const session = await startTuiTestSession({
        home,
        dependencies: () => {
            const dependencies = createTuiChildDependencies();
            return {
                ...dependencies,
                client: { ...dependencies.client, workspace },
                openConfigurationFile: async (path) => {
                    openedPaths.push(path);
                },
            };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/configure");
        session.sendKey("Enter");
        const picker = await session.waitForVisiblePane(
            "Choose a configuration file to edit",
        );
        expect(picker).toContain("Profile config");
        expect(picker).toContain("TUI preferences");
        expect(picker).toContain("Project config");
        expect(picker).toContain("Profile");
        expect(picker).toContain("Project");

        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Project config editor closed:");
        expect(openedPaths).toEqual([projectConfig]);

        session.sendText("/configure");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Choose a configuration file to edit");
        rmSync(tuiPreferences);
        session.sendKey("Down");
        session.sendKey("Enter");
        const error = await session.waitForVisiblePane(
            "TUI preferences is no longer available",
        );
        expect(error).toContain("tui.json");
        expect(openedPaths).toEqual([projectConfig]);
    } finally {
        await session.close();
    }
}, 15_000);
