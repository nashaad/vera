import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Parser } from "htmlparser2";
import {
    Agent,
    fetch as undiciFetch,
} from "undici/index.js";

import type { RegisteredTool, ToolOutput } from "./types.ts";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** A PDF carries its fonts and layout in the same file as its text, so the
 * text-sized budget rejects documents that are ordinary to publish. */
const MAX_PDF_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 50_000;
const REQUEST_TIMEOUT_MS = 20_000;

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
            "Fetch one public HTTP or HTTPS URL and return bounded readable",
            "text. Handles HTML, plain text, JSON, XML, and PDF, extracting a",
            "PDF's text automatically. Use this instead of writing a script or",
            "invoking curl when the page contents are needed. Local and",
            "private-network targets, other binary responses, oversized",
            "bodies, and slow requests are rejected.",
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
    let current = parsePublicUrl(input);

    try {
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
            const addresses = await publicAddresses(
                current,
                resolveHost,
                combined,
            );
            const response = await transport.request(current, {
                headers: {
                    Accept:
                        "text/html,application/xhtml+xml,text/plain,"
                        + "application/json;q=0.8,application/pdf;q=0.8,"
                        + "*/*;q=0.1",
                    "User-Agent": "Vera/2 web_fetch",
                },
                redirect: "manual",
                signal: combined,
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

            const contentType = response.headers.get("content-type") ?? "";
            if (isPdfContentType(contentType)) {
                const bytes = await readBoundedBytes(
                    response,
                    MAX_PDF_RESPONSE_BYTES,
                );
                return formatReadablePage(
                    current.href,
                    await pdfText(bytes),
                    contentType,
                );
            }
            if (!isReadableContentType(contentType)) {
                await response.body?.cancel();
                throw new Error(
                    `web_fetch does not support content type ${contentType || "(missing)"}`,
                );
            }
            const body = await readBoundedBody(response);
            return formatReadablePage(current.href, body, contentType);
        }
        throw new Error("web_fetch redirect handling failed");
    } finally {
        await transport.close();
    }
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
            return await undiciFetch(url, {
                headers: init.headers as Record<string, string>,
                redirect: init.redirect,
                signal: init.signal,
                dispatcher: agent,
            }) as unknown as Response;
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

/**
 * The bytes come from an arbitrary public URL, so the parser gets no way to
 * reach the network on the document's behalf and no font handling: extracting
 * text needs neither, and a fetch driven by document contents would sidestep
 * the address checks every other request here goes through.
 */
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

async function readBoundedBody(response: Response): Promise<string> {
    return new TextDecoder().decode(
        await readBoundedBytes(response, MAX_RESPONSE_BYTES),
    );
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
    const html = contentType.toLowerCase().includes("html");
    const extracted = html ? readableHtml(body) : undefined;
    const title = extracted?.title ?? "";
    const readable = extracted?.text ?? body.trim();
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

function readableHtml(html: string): { readonly title: string; readonly text: string } {
    const skipped = new Set([
        "head",
        "script",
        "style",
        "noscript",
        "iframe",
        "object",
        "embed",
        "svg",
    ]);
    const blocks = new Set([
        "article",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "section",
        "tr",
    ]);
    let text = "";
    let title = "";
    let skipDepth = 0;
    let titleDepth = 0;
    const parser = new Parser({
        onopentag(name) {
            if (name === "title") titleDepth += 1;
            if (skipDepth > 0 || skipped.has(name)) {
                skipDepth += 1;
                return;
            }
            if (blocks.has(name)) text += "\n";
        },
        ontext(value) {
            if (titleDepth > 0) title += value;
            if (skipDepth === 0) text += value;
        },
        onclosetag(name) {
            if (name === "title" && titleDepth > 0) titleDepth -= 1;
            if (skipDepth > 0) {
                skipDepth -= 1;
                return;
            }
            if (blocks.has(name)) text += "\n";
        },
    }, { decodeEntities: true });
    parser.end(html);
    return {
        title: title.replace(/\s+/g, " ").trim(),
        text: text
        .replace(/[ \t]+/g, " ")
        .replace(/ +([.,;:!?])/g, "$1")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    };
}
