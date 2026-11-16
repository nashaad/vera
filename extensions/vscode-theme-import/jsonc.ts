import { ThemeRefusal } from "./refusal.ts";

const MAX_ENGINE_MESSAGE = 120;

// Comments and the BOM become spaces and newlines stay, so an error position still points at the original text.
function blank(text: string, from: number, to: number): string {
    return text.slice(from, to).replace(/[^\n]/g, " ");
}

function stripJsonc(text: string): string {
    const out: string[] = [];
    let commaAt = -1;
    let index = 0;
    if (text.startsWith("﻿")) {
        out.push(" ");
        index = 1;
    }
    while (index < text.length) {
        const char = text.charAt(index);
        const next = text.charAt(index + 1);
        if (char === "\"") {
            let end = index + 1;
            while (end < text.length && text.charAt(end) !== "\"" && text.charAt(end) !== "\n") {
                end += text.charAt(end) === "\\" ? 2 : 1;
            }
            out.push(text.slice(index, end + 1));
            index = end + 1;
            commaAt = -1;
        } else if (char === "/" && next === "/") {
            let end = text.indexOf("\n", index);
            if (end === -1) end = text.length;
            out.push(blank(text, index, end));
            index = end;
        } else if (char === "/" && next === "*") {
            const close = text.indexOf("*/", index + 2);
            if (close === -1) throw new ThemeRefusal("The file has a comment that is never closed.");
            out.push(blank(text, index, close + 2));
            index = close + 2;
        } else {
            if (char === ",") {
                commaAt = out.length;
            } else if ((char === "}" || char === "]") && commaAt !== -1) {
                out[commaAt] = " ";
                commaAt = -1;
            } else if (!/\s/.test(char)) {
                commaAt = -1;
            }
            out.push(char);
            index += 1;
        }
    }
    return out.join("");
}

// JSON with comments and trailing commas, the way VS Code theme files are written.
export function parseJsonc(text: string): unknown {
    const plain = stripJsonc(text);
    try {
        return JSON.parse(plain);
    } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, MAX_ENGINE_MESSAGE) : "";
        throw new ThemeRefusal(`The file is not valid JSON${detail.length > 0 ? ` (${detail})` : ""}.`);
    }
}
