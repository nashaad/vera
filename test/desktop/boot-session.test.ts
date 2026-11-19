import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BootSession } from "../../clients/desktop/src/boot.ts";
import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";

const FAKE_BOOT = `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_KIND_FILE, process.env.VERA_HOST_REQUESTER_KIND ?? "");
console.log(JSON.stringify({ type: "check", label: "fake", status: "ok" }));
console.log(JSON.stringify({ type: "question", id: "stop_answering_host", text: "Restart the host?" }));
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
    kindFile: string;
} {
    const root = mkdtempSync(join(tmpdir(), "vera-boot-session-"));
    const answerFile = join(root, "answers.txt");
    const kindFile = join(root, "kind.txt");
    writeFileSync(answerFile, "");
    writeFileSync(kindFile, "");
    const script = join(root, "fake-boot.ts");
    writeFileSync(script, FAKE_BOOT);
    process.env.VERA_DESKTOP_DEV_CLI = script;
    process.env.VERA_DESKTOP_BUN = process.execPath;
    process.env.FAKE_ANSWER_FILE = answerFile;
    process.env.FAKE_KIND_FILE = kindFile;
    const events: DesktopEvent[] = [];
    return {
        root,
        events,
        answerFile,
        kindFile,
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
    delete process.env.FAKE_KIND_FILE;
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
        expect(id).toBe("stop_answering_host");
        expect(readFileSync(helper.kindFile, "utf8")).toBe("desktop");
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

test("a failed preflight reports its message and never starts the Vera command", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        async () => ({ kind: "stop", message: "The install failed." }),
    );
    try {
        session.start();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(helper.events).toEqual([
            { type: "phase", phase: "starting" },
            { type: "failed", message: "The install failed." },
        ]);
        expect(readFileSync(helper.answerFile, "utf8")).toBe("");
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("a preflight that throws is reported as a failure", async () => {
    const helper = setup();
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        async () => {
            throw new Error("disk full");
        },
    );
    try {
        session.start();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(helper.events).toEqual([
            { type: "phase", phase: "starting" },
            { type: "failed", message: "disk full" },
        ]);
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("a passing preflight runs before the Vera command starts", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const order: string[] = [];
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => {
            order.push(event.type);
            helper.events.push(event);
        },
        async () => {
            order.push("preflight");
            return { kind: "continue" };
        },
    );
    try {
        session.start();
        await waitForAnswer(helper.answerFile, "stdin-closed");
        expect(order).toEqual(["phase", "preflight", "ready"]);
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("cancelling during a preflight stops the boot before it starts the Vera command", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    let release: () => void = () => {};
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        () => new Promise((resolve) => {
            release = () => resolve({ kind: "continue" });
        }),
    );
    try {
        session.start();
        session.cancel();
        release();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(helper.events).toEqual([{ type: "phase", phase: "starting" }]);
        expect(readFileSync(helper.answerFile, "utf8")).toBe("");
    } finally {
        cleanup(helper.root);
    }
});

test("an install shows the installing phase, then starting again before the Vera command runs", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        async (hooks) => {
            hooks.installing();
            hooks.installing();
            return { kind: "continue" };
        },
    );
    try {
        session.start();
        await waitForAnswer(helper.answerFile, "stdin-closed");
        expect(helper.events.map((event) => event.type === "phase" ? event.phase : event.type)).toEqual([
            "starting",
            "installing",
            "starting",
            "ready",
        ]);
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("a preflight that installs nothing never shows the installing phase", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        async () => ({ kind: "continue" }),
    );
    try {
        session.start();
        await waitForAnswer(helper.answerFile, "stdin-closed");
        expect(helper.events.map((event) => event.type)).toEqual(["phase", "ready"]);
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("a notice from the preflight is sent before the host attaches", async () => {
    const helper = setup();
    writeFileSync(join(helper.root, "fake-boot.ts"), FAKE_READY);
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        async (hooks) => {
            hooks.installing();
            return { kind: "continue", notice: "The archive is damaged." };
        },
    );
    try {
        session.start();
        await waitForAnswer(helper.answerFile, "stdin-closed");
        expect(helper.events.map((event) => event.type)).toEqual(["phase", "phase", "install_notice", "phase", "ready"]);
        expect(helper.events[2]).toEqual({ type: "install_notice", message: "The archive is damaged." });
    } finally {
        session.cancel();
        cleanup(helper.root);
    }
});

test("an install that is cancelled shows no installing phase afterwards", async () => {
    const helper = setup();
    let install: () => void = () => {};
    const session = new BootSession(
        "/tmp/vera-boot-test",
        (event) => helper.events.push(event),
        (hooks) => new Promise((resolve) => {
            install = () => {
                hooks.installing();
                resolve({ kind: "continue" });
            };
        }),
    );
    try {
        session.start();
        session.cancel();
        install();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(helper.events).toEqual([{ type: "phase", phase: "starting" }]);
    } finally {
        cleanup(helper.root);
    }
});
