import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface CaptureOptions {
    readonly url: string;
    readonly outPath: string;
    readonly width: number;
    readonly scale: number;
    // Runs in the page after load; resolve once the page shows what to capture.
    readonly prepare?: string;
}

export async function captureFullPage(options: CaptureOptions): Promise<void> {
    const chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME;
    if (!existsSync(chromePath)) {
        throw new Error(`Chrome not found at ${chromePath}; set CHROME_PATH`);
    }
    const profile = mkdtempSync(join(tmpdir(), "vera-shot-chrome-"));
    const chrome = spawn(chromePath, [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--hide-scrollbars",
        "--force-dark-mode",
        "about:blank",
    ], { stdio: "ignore" });
    try {
        const port = await waitForDevToolsPort(profile);
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((target) => target.type === "page");
        if (page === undefined) throw new Error("Chrome opened no page");
        const cdp = await connect(page.webSocketDebuggerUrl);
        try {
            const metrics = (height: number) => cdp.send("Emulation.setDeviceMetricsOverride", {
                width: options.width,
                height,
                deviceScaleFactor: options.scale,
                mobile: false,
            });
            await metrics(900);
            await cdp.send("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value: "dark" }],
            });
            await cdp.send("Page.enable");
            const loaded = cdp.once("Page.loadEventFired");
            await cdp.send("Page.navigate", { url: options.url });
            await loaded;
            if (options.prepare !== undefined) {
                await evaluate(cdp, options.prepare);
            }
            const height = await evaluate(cdp, "document.documentElement.scrollHeight") as number;
            await metrics(height);
            await Bun.sleep(300);
            const shot = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
            writeFileSync(options.outPath, Buffer.from(shot.data, "base64"));
        } finally {
            cdp.close();
        }
    } finally {
        chrome.kill();
        await new Promise((resolve) => chrome.once("exit", resolve));
        rmSync(profile, { recursive: true, force: true });
    }
}

async function waitForDevToolsPort(profile: string): Promise<number> {
    const file = join(profile, "DevToolsActivePort");
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(file)) {
            const port = Number(readFileSync(file, "utf8").split("\n")[0]);
            if (port > 0) return port;
        }
        await Bun.sleep(100);
    }
    throw new Error("Chrome did not open a DevTools port");
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    }) as { result: { value?: unknown }; exceptionDetails?: { text: string } };
    if (result.exceptionDetails !== undefined) {
        throw new Error(`page script failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
}

interface Cdp {
    send(method: string, params?: object): Promise<unknown>;
    once(event: string): Promise<unknown>;
    close(): void;
}

async function connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const waiters = new Map<string, ((params: unknown) => void)[]>();
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { message: string };
        };
        if (message.id !== undefined) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error !== undefined) entry?.reject(new Error(message.error.message));
            else entry?.resolve(message.result);
            return;
        }
        if (message.method !== undefined) {
            const list = waiters.get(message.method) ?? [];
            waiters.delete(message.method);
            for (const waiter of list) waiter(message.params);
        }
    });
    return {
        send(method, params = {}) {
            const id = ++nextId;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        },
        once(event) {
            return new Promise((resolve) => {
                const list = waiters.get(event) ?? [];
                list.push(resolve);
                waiters.set(event, list);
            });
        },
        close() {
            socket.close();
        },
    };
}
