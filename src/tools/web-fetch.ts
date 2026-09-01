import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
    Agent,
    request as undiciRequest,
} from "undici/index.js";

import { htmlToMarkdown } from "./html-to-markdown.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTML_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 50_000;
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

type Fetch = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export interface ResolvedAddress {
    readonly address: string;
    readonly family: 4 | 6;
}

type ResolveHost = (
    hostname: string,
    signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

interface FetchTransport {
    request(
        url: URL,
        init: RequestInit,
        addresses: readonly ResolvedAddress[],
    ): Promise<Response>;
    close(): Promise<void>;
}

export const webFetchTool: RegisteredTool = {
    parallel: true,
    permissionOperation: "web.fetch",
    permissionInputs: [{ field: "url", kind: "url", verb: "read" }],
    definition: {
        name: "web_fetch",
        description: [
            "Read one public HTTP or HTTPS URL and return bounded readable",
            "text. Handles HTML, plain text, JSON, XML, and PDF, extracting a",
            "PDF's text automatically. This tool never writes a file: to save",
            "a URL to disk, including a PDF, call web_download instead. Use",
            "this instead of writing a script or invoking curl when the page",
            "contents are needed. Local and private-network targets, other",
            "binary responses, oversized bodies, and slow requests are",
            "rejected.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The public HTTP or HTTPS URL to read.",
                },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    async execute(input, _context, signal): Promise<ToolOutput> {
        if (typeof input.url !== "string" || input.url.trim().length === 0) {
            throw new Error("web_fetch requires a non-empty url");
        }
        return {
            kind: "output",
            output: await fetchReadablePage(input.url.trim(), signal),
            isError: false,
        };
    },
};

export async function fetchReadablePage(
    input: string,
    signal: AbortSignal,
    fetcher?: Fetch,
    resolveHost: ResolveHost = resolvePublicHost,
): Promise<string> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const transport = fetcher === undefined
        ? pinnedTransport()
        : injectedTransport(fetcher);
    try {
        const { response, url } = await openPublicResponse(
            input,
            combined,
            transport,
            resolveHost,
        );
        const contentType = response.headers.get("content-type") ?? "";
        if (isPdfContentType(contentType)) {
            const bytes = await readBoundedBytes(
                response,
                MAX_PDF_RESPONSE_BYTES,
            );
            return `${formatReadablePage(
                url.href,
                await pdfText(bytes),
                contentType,
            )}\n\nThis is the PDF's text. No file was saved. `
                + "To put the file on disk, call web_download with this URL.";
        }
        if (!isReadableContentType(contentType)) {
            await response.body?.cancel();
            throw new Error(
                `web_fetch cannot read content type ${contentType || "(missing)"}; `
                + "use web_download to save this URL to a file instead",
            );
        }
        return formatReadablePage(
            url.href,
            await readBoundedBody(response, bodyByteLimit(contentType)),
            contentType,
        );
    } finally {
        await transport.close();
    }
}

async function openPublicResponse(
    input: string,
    signal: AbortSignal,
    transport: FetchTransport,
    resolveHost: ResolveHost,
): Promise<{ readonly response: Response; readonly url: URL }> {
    let current = parsePublicUrl(input);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const addresses = await publicAddresses(current, resolveHost, signal);
        const response = await transport.request(current, {
            headers: {
                Accept:
                    "text/html,application/xhtml+xml,text/plain,"
                    + "application/json;q=0.8,application/pdf;q=0.8,"
                    + "*/*;q=0.1",
                "User-Agent": "Vera/2 web_fetch",
            },
            redirect: "manual",
            signal,
        }, addresses);

        if (isRedirect(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (location === null) {
                throw new Error(
                    `web_fetch received HTTP ${response.status} without a redirect location`,
                );
            }
            if (redirects === MAX_REDIRECTS) {
                throw new Error(
                    `web_fetch followed more than ${MAX_REDIRECTS} redirects`,
                );
            }
            current = parsePublicUrl(new URL(location, current).href);
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`web_fetch failed with HTTP ${response.status}`);
        }
        return { response, url: current };
    }
    throw new Error("web_fetch redirect handling failed");
}

async function resolvePublicHost(
    hostname: string,
    _signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.flatMap(({ address, family }) =>
        family === 4 || family === 6 ? [{ address, family }] : []
    );
}

async function publicAddresses(
    url: URL,
    resolveHost: ResolveHost,
    signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
    const hostname = unbracketed(url.hostname).toLowerCase();
    if (
        hostname === "localhost"
        || hostname.endsWith(".localhost")
        || hostname.endsWith(".local")
    ) {
        throw new Error("web_fetch rejects local and private-network URLs");
    }
    const literalFamily = isIP(hostname);
    const addresses = literalFamily === 0
        ? await abortable(resolveHost(hostname, signal), signal)
        : [{
            address: hostname,
            family: literalFamily as 4 | 6,
        }];
    if (
        addresses.length === 0
        || addresses.some(({ address }) => !isPublicAddress(address))
    ) {
        throw new Error("web_fetch rejects local and private-network URLs");
    }
    return addresses;
}

function injectedTransport(fetcher: Fetch): FetchTransport {
    return {
        request(url, init): Promise<Response> {
            return fetcher(url, init);
        },
        async close(): Promise<void> {},
    };
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function pinnedTransport(): FetchTransport {
    const pinned = new Map<string, readonly ResolvedAddress[]>();
    const agent = new Agent({
        connect: {
            lookup(hostname, options, callback) {
                const addresses = pinned.get(hostname.toLowerCase());
                if (addresses === undefined || addresses.length === 0) {
                    callback(new Error(
                        `web_fetch has no validated address for ${hostname}`,
                    ), []);
                    return;
                }
                if (options.all) {
                    callback(null, [...addresses]);
                    return;
                }
                const first = addresses[0]!;
                callback(null, first.address, first.family);
            },
        },
    });
    return {
        async request(url, init, addresses): Promise<Response> {
            pinned.set(unbracketed(url.hostname).toLowerCase(), addresses);
            const response = await undiciRequest(url, {
                method: "GET",
                headers: init.headers as Record<string, string>,
                signal: init.signal,
                dispatcher: agent,
            });
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                for (const one of Array.isArray(value) ? value : [value]) {
                    if (one !== undefined) {
                        headers.append(name, one);
                    }
                }
            }
            if (NULL_BODY_STATUSES.has(response.statusCode)) {
                await response.body.dump();
                return new Response(null, {
                    status: response.statusCode,
                    headers,
                });
            }
            return new Response(
                Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
                { status: response.statusCode, headers },
            );
        },
        async close(): Promise<void> {
            await agent.close();
        },
    };
}

async function abortable<T>(
    operation: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    return Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
            });
        }),
    ]);
}

function parsePublicUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("web_fetch url must be an absolute HTTP or HTTPS URL");
    }
    if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || url.username.length > 0
        || url.password.length > 0
    ) {
        throw new Error(
            "web_fetch url must use HTTP or HTTPS without embedded credentials",
        );
    }
    return url;
}

function isPublicAddress(value: string): boolean {
    const address = unbracketed(value).toLowerCase();
    const version = isIP(address);
    if (version === 4) {
        const parts = address.split(".").map(Number);
        const [a, b] = parts;
        return a !== undefined
            && b !== undefined
            && a !== 0
            && a !== 10
            && a !== 127
            && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 169 && b === 254)
            && !(a === 172 && b >= 16 && b <= 31)
            && !(a === 192 && b === 0)
            && !(a === 192 && b === 168)
            && !(a === 198 && (b === 18 || b === 19))
            && !(a === 198 && b === 51)
            && !(a === 203 && b === 0)
            && a < 224;
    }
    if (version === 6) {
        return /^[23]/.test(address)
            && !address.startsWith("2001:db8:");
    }
    return false;
}

function unbracketed(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
}

function isRedirect(status: number): boolean {
    return status === 301
        || status === 302
        || status === 303
        || status === 307
        || status === 308;
}

function isPdfContentType(value: string): boolean {
    return mimeOf(value) === "application/pdf";
}

function isHtmlContentType(value: string): boolean {
    const mime = mimeOf(value);
    return mime === "text/html"
        || mime === "application/xhtml+xml"
        || mime.endsWith("+html");
}

function bodyByteLimit(contentType: string): number {
    return isHtmlContentType(contentType)
        ? MAX_HTML_RESPONSE_BYTES
        : MAX_RESPONSE_BYTES;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
    const { extractText, getDocumentProxy } = await import("unpdf");
    let document;
    try {
        document = await getDocumentProxy(bytes, {
            verbosity: 0,
            disableAutoFetch: true,
            disableStream: true,
            disableFontFace: true,
        });
    } catch {
        throw new Error("web_fetch could not read that PDF");
    }
    try {
        const { text } = await extractText(document, { mergePages: true });
        const readable = (Array.isArray(text) ? text.join("\n") : text)
            .replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        if (readable.length === 0) {
            throw new Error(
                "web_fetch found no selectable text in that PDF; it is likely scanned images",
            );
        }
        return readable;
    } finally {
        await Promise.resolve(document.cleanup()).catch(() => undefined);
    }
}

function mimeOf(value: string): string {
    return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isReadableContentType(value: string): boolean {
    const mime = mimeOf(value);
    return mime.length === 0
        || mime.startsWith("text/")
        || mime === "application/json"
        || mime.endsWith("+json")
        || mime === "application/xml"
        || mime.endsWith("+xml");
}

async function readBoundedBody(
    response: Response,
    limit: number,
): Promise<string> {
    return new TextDecoder().decode(await readBoundedBytes(response, limit));
}

async function readBoundedBytes(
    response: Response,
    limit: number,
): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (
        Number.isFinite(declaredLength)
        && declaredLength > limit
    ) {
        await response.body?.cancel();
        throw new Error(
            `web_fetch response exceeds ${limit} bytes`,
        );
    }
    if (response.body === null) {
        return new Uint8Array(0);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > limit) {
                throw new Error(
                    `web_fetch response exceeds ${limit} bytes`,
                );
            }
            chunks.push(next.value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function formatReadablePage(
    url: string,
    body: string,
    contentType: string,
): string {
    const extracted = isHtmlContentType(contentType)
        ? htmlToMarkdown(body, url)
        : undefined;
    const title = extracted?.title ?? "";
    const readable = extracted?.markdown ?? body.trim();
    const truncated = readable.length > MAX_OUTPUT_CHARACTERS;
    const output = truncated
        ? readable.slice(0, MAX_OUTPUT_CHARACTERS)
        : readable;
    return [
        `URL: ${url}`,
        ...(title.length === 0 ? [] : [`Title: ${title}`]),
        "",
        output,
        ...(truncated
            ? [
                "",
                `(truncated at ${MAX_OUTPUT_CHARACTERS} characters)`,
            ]
            : []),
    ].join("\n").trimEnd();
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export async function downloadPublicFile(
    input: string,
    directory: string,
    signal: AbortSignal,
    fetcher?: Fetch,
    resolveHost: ResolveHost = resolvePublicHost,
): Promise<{ readonly path: string; readonly bytes: number }> {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const transport = fetcher === undefined
        ? pinnedTransport()
        : injectedTransport(fetcher);
    try {
        const { response, url } = await openPublicResponse(
            input,
            combined,
            transport,
            resolveHost,
        );
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
            await response.body?.cancel();
            throw new Error(
                `web_download response exceeds ${MAX_DOWNLOAD_BYTES} bytes`,
            );
        }
        const bytes = await readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
        await mkdir(directory, { recursive: true });
        const path = await unusedPath(
            directory,
            downloadName(url, response.headers.get("content-disposition")),
        );
        await writeFile(path, bytes);
        return { path, bytes: bytes.byteLength };
    } finally {
        await transport.close();
    }
}

function downloadName(url: URL, disposition: string | null): string {
    const fromHeader = disposition
        ?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    const raw = fromHeader ?? decodeURIComponent(url.pathname);
    const candidate = raw.split("/").pop()?.trim() ?? "";
    const safe = candidate
        .replace(/[/\\\u0000]/g, "")
        .replace(/^\.+/, "")
        .slice(0, 120);
    return safe.length === 0 ? "download" : safe;
}

async function unusedPath(directory: string, name: string): Promise<string> {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let index = 0; index < 1000; index += 1) {
        const candidate = join(
            directory,
            index === 0 ? name : `${stem} (${index})${extension}`,
        );
        if (!existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`web_download found no free name for ${name}`);
}
