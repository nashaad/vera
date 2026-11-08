import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startReopenTmux } from "../support/reopen-tmux.ts";

for (const typedFirst of [false, true]) {
    test(typedFirst ? "switching from an untouched conversation asks nothing" : "a Home slash command starts no conversation", async () => {
        const session = startReopenTmux("home");
        try {
            await session.waitFor((pane) => pane.includes("or just start typing"), "Home");
            if (typedFirst) {
                session.text("x");
                await session.waitFor((pane) => pane.includes("│ x"), "empty conversation with draft");
                session.key("C-e");
            } else {
                session.text("/resume");
                session.key("Enter");
            }
            await session.waitFor((pane) => pane.includes("Continue the theme picker"), "resume picker");
            expect(existsSync(join(session.home, "created"))).toBe(typedFirst);
            session.text("Continue the theme picker");
            await session.waitFor((pane) => pane.includes("Continue the theme picker") && !pane.includes("The one already open"), "filtered picker");
            session.key("Enter");
            const result = await session.waitFor((pane) => pane.includes("RESUMED HISTORY LOADED") || pane.includes("Stop & switch"), "switch result");
            expect(result).toContain("RESUMED HISTORY LOADED");
            expect(result).not.toContain("Stop & switch");
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("a running empty conversation still asks how to leave", async () => {
    const session = startReopenTmux("home-busy");
    try {
        await session.waitFor((pane) => pane.includes("or just start typing"), "Home");
        session.text("x");
        await session.waitFor((pane) => pane.includes("│ x") && pane.includes("Working"), "running conversation");
        session.key("C-e");
        await session.waitFor((pane) => pane.includes("Continue the theme picker"), "resume picker");
        session.text("Continue the theme picker");
        await session.waitFor((pane) => pane.includes("Continue the theme picker") && !pane.includes("The one already open"), "filtered picker");
        session.key("Enter");
        const result = await session.waitFor((pane) => pane.includes("Stop & switch"), "leave confirmation");
        expect(result).toContain("Switch, keep running");
    } finally {
        await session.close();
    }
}, 15_000);

test("work starting with the picker open still asks how to leave", async () => {
    const session = startReopenTmux("home-late-busy");
    try {
        await session.waitFor((pane) => pane.includes("or just start typing"), "Home");
        session.text("x");
        await session.waitFor((pane) => pane.includes("│ x"), "empty conversation");
        session.key("C-e");
        await session.waitFor((pane) => pane.includes("Continue the theme picker"), "resume picker");
        session.text("Continue the theme picker");
        await session.waitFor((pane) => pane.includes("Continue the theme picker") && !pane.includes("The one already open"), "filtered picker");
        await Bun.sleep(2_000);
        session.key("Enter");
        const result = await session.waitFor((pane) => pane.includes("Stop & switch") || pane.includes("RESUMED HISTORY LOADED"), "switch result");
        expect(result).toContain("Stop & switch");
    } finally {
        await session.close();
    }
}, 15_000);

test("Escape cancels command input on Home", async () => {
    const session = startReopenTmux("home");
    try {
        await session.waitFor((pane) => pane.includes("or just start typing"), "Home");
        session.text("/");
        const input = await session.waitFor((pane) => pane.includes("│ /"), "command input");
        expect(input).toContain("/resume");
        expect(input).not.toContain("/rewind");
        session.key("Escape");
        const result = await session.waitFor((pane) => pane.includes("or just start typing"), "Home after Escape");
        expect(result).not.toContain("Message Vera");
        expect(existsSync(join(session.home, "created"))).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);

test("the new-conversation slash command leaves Home without creating a worker", async () => {
    const session = startReopenTmux("home");
    try {
        await session.waitFor((pane) => pane.includes("or just start typing"), "Home");
        session.text("/new");
        await session.waitFor((pane) => pane.includes("│ /new"), "new-conversation command");
        session.key("Enter");
        await session.waitFor((pane) => pane.includes("or just start typing"), "Home after command");
        expect(existsSync(join(session.home, "created"))).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);
