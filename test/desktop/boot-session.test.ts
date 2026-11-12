import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BootSession } from "../../clients/desktop/src/boot.ts";
import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";

const FAKE_BOOT = `
import { appendFileSync } from "node:fs";
console.log(JSON.stringify({ type: "check", label: "fake", status: "ok" }));
console.log(JSON.stringify({ type: "question", id: "q1", text: "Restart the host?" }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    for (const line of chunk.split("\\n")) {
        if (line.trim().length === 0) continue;
        const value = JSON.parse(line);
        appendFileSync(process.env.FAKE_ANSWER_FILE, String(value.answer) + "\\n");
    }
});
process.stdin.on("end", () => process.exit(0));
`;

function setup(): {
    root: string;
    events: DesktopEvent[];
    waitForQuestion: () => Promise<string>;
    answerFile: string;
} {
    const root = mkdtempSync(join(tmpdir(), "vera-boot-session-"));
    const answerFile = join(root, "answers.txt");
    writeFileSync(answerFile, "");
    const script = join(root, "fake-boot.ts");
    writeFileSync(script, FAKE_BOOT);
    process.env.VERA_DESKTOP_DEV_CLI = script;
    process.env.VERA_DESKTOP_BUN = process.execPath;
    process.env.FAKE_ANSWER_FILE = answerFile;
    const events: DesktopEvent[] = [];
    return {
        root,
        events,
        answerFile,
        waitForQuestion: async () => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const question = events.find((event) => event.type === "question");
                if (question !== undefined && question.type === "question") return question.id;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error("The fake boot never asked a question.");
        },
    };
}

function cleanup(root: string): void {
    delete process.env.VERA_DESKTOP_DEV_CLI;
    delete process.env.VERA_DESKTOP_BUN;
    delete process.env.FAKE_ANSWER_FILE;
    rmSync(root, { recursive: true, force: true });
}

async function waitForAnswer(file: string, expected: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(file) && readFileSync(file, "utf8").includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`The fake boot never received ${expected}.`);
}

test("@core the desktop sends only the answer the person picked", async () => {
    const helper = setup();
    const session = new BootSession("/tmp/vera-boot-test", (event) => helper.events.push(event));
    try {
        session.start();
        const id = await helper.waitForQuestion();
        session.answer(id, true);
        await waitForAnswer(helper.answerFile, "true");
        expect(readFileSync(helper.answerFile, "utf8").trim()).toBe("true");
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("@core cancelling a pending question writes no before closing stdin", async () => {
    const helper = setup();
    const session = new BootSession("/tmp/vera-boot-test", (event) => helper.events.push(event));
    try {
        session.start();
        await helper.waitForQuestion();
        session.cancel();
        await waitForAnswer(helper.answerFile, "false");
        expect(readFileSync(helper.answerFile, "utf8").trim()).toBe("false");
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

const FAKE_READY = `
import { appendFileSync } from "node:fs";
console.log(JSON.stringify({ type: "ready", pid: 4242, socket_path: "/tmp/vera-fake.sock", build_id: "abcdef1234" }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => appendFileSync(process.env.FAKE_ANSWER_FILE, chunk));
process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_ANSWER_FILE, "stdin-closed\\n");
    process.exit(0);
});
process.stdin.resume();
`;

test("@core a ready host releases the boot child by closing stdin without an answer", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession("/tmp/vera-boot-test", (event) => helper.events.push(event));
    try {
        session.start();
        await waitForAnswer(helper.answerFile, "stdin-closed");
        expect(readFileSync(helper.answerFile, "utf8").trim()).toBe("stdin-closed");
        expect(helper.events.map((event) => event.type)).toEqual(["phase", "ready"]);
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("@core a boot session starts once", () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession("/tmp/vera-boot-test", (event) => helper.events.push(event));
    try {
        session.start();
        expect(() => session.start()).toThrow();
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});
