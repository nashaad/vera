import { expect, test } from "bun:test";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { CATALOG_TOO_LARGE, CATALOG_TOO_MANY, CATALOG_UNREAD, parseCatalog } from "../../clients/desktop/src/extension-catalog/parse-catalog.ts";
import { MAX_CATALOG_BYTES, MAX_CATALOG_ENTRIES } from "../../clients/desktop/src/extension-catalog/task-protocol.ts";
import { MAX_PACKAGE_BYTES } from "../../clients/desktop/src/extensions/limits.ts";
import { catalogBytes, PALETTE, rawEntry } from "./extension-catalog-fixtures.ts";

const URL_OF = "http://127.0.0.1:1/crow.tgz";
const PACKAGE = Buffer.from("package bytes");

function parse(extensions: readonly unknown[], format: unknown = 1) {
    return parseCatalog(catalogBytes(extensions, format), DESKTOP_ENGINE);
}

test("@core a catalog lists its theme entries with the fields the window needs", () => {
    const entries = parse([rawEntry(URL_OF, PACKAGE), rawEntry(URL_OF, PACKAGE, { id: "crow.two", name: "Two", version: "2.1.0" })]);
    expect(entries.map((entry) => [entry.id, entry.name, entry.version])).toEqual([["crow.pack", "Crow Night", "1.0.0"], ["crow.two", "Two", "2.1.0"]]);
    expect(entries[0]).toEqual({ id: "crow.pack", name: "Crow Night", version: "1.0.0", url: URL_OF, sha256: expect.any(String), size: PACKAGE.length, palette: PALETTE });
});

test("@core withdrawn entries and entries for another engine or kind are not listed", () => {
    const entries = parse([
        rawEntry(URL_OF, PACKAGE, { id: "crow.kept" }),
        rawEntry(URL_OF, PACKAGE, { id: "crow.withdrawn", withdrawn: true }),
        rawEntry(URL_OF, PACKAGE, { id: "crow.engine", engine: "vera-gui@^2" }),
        rawEntry(URL_OF, PACKAGE, { id: "crow.kind", kind: "skill" }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["crow.kept"]);
});

test("@core an entry with a bad field is left out and the others are kept", () => {
    const bad: Record<string, unknown>[] = [
        { id: "Upper.Case" },
        { id: "" },
        { id: "a".repeat(81) },
        { name: "" },
        { name: "x".repeat(121) },
        { name: "two\nlines" },
        { version: "" },
        { version: "1 0" },
        { url: "ftp://127.0.0.1/crow.tgz" },
        { url: "file:///etc/passwd" },
        { url: "not a url" },
        { url: 7 },
        { sha256: "abc" },
        { sha256: "A".repeat(64) },
        { size: 0 },
        { size: 1.5 },
        { size: "719" },
        { size: MAX_PACKAGE_BYTES + 1 },
        { palette: PALETTE.slice(0, 4) },
        { palette: [...PALETTE, "#000000"] },
        { palette: ["red", ...PALETTE.slice(1)] },
        { palette: ["#07080A", ...PALETTE.slice(1)] },
        { palette: ["url(javascript:1)", ...PALETTE.slice(1)] },
        { withdrawn: "no" },
        { withdrawn: undefined },
    ];
    const entries = parse([...bad.map((fields) => rawEntry(URL_OF, PACKAGE, fields)), "text", null, [], rawEntry(URL_OF, PACKAGE, { id: "crow.kept" })]);
    expect(entries.map((entry) => entry.id)).toEqual(["crow.kept"]);
});

test("@core the first entry for an id is the one listed", () => {
    const entries = parse([rawEntry(URL_OF, PACKAGE, { version: "1.0.0" }), rawEntry(URL_OF, PACKAGE, { version: "2.0.0" })]);
    expect(entries.map((entry) => entry.version)).toEqual(["1.0.0"]);
});

test("@core a catalog that is too large or lists too many extensions is refused whole", () => {
    expect(() => parseCatalog(Buffer.alloc(MAX_CATALOG_BYTES + 1, 0x20), DESKTOP_ENGINE)).toThrow(CATALOG_TOO_LARGE);
    const many = Array.from({ length: MAX_CATALOG_ENTRIES + 1 }, (_, index) => rawEntry(URL_OF, PACKAGE, { id: `crow.n${index}` }));
    expect(() => parse(many)).toThrow(CATALOG_TOO_MANY);
    expect(parse(many.slice(0, MAX_CATALOG_ENTRIES))).toHaveLength(MAX_CATALOG_ENTRIES);
    expect(CATALOG_TOO_LARGE).toBe("The catalog is larger than 1 MiB.");
});

test("@core a catalog that is not the expected shape is refused", () => {
    const refused: Uint8Array[] = [
        Buffer.from("not json"),
        Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
        Buffer.from("[]"),
        Buffer.from("null"),
        Buffer.from(JSON.stringify({ format: 2, extensions: [] })),
        Buffer.from(JSON.stringify({ extensions: [] })),
        Buffer.from(JSON.stringify({ format: 1 })),
        Buffer.from(JSON.stringify({ format: 1, extensions: {} })),
    ];
    for (const bytes of refused) expect(() => parseCatalog(bytes, DESKTOP_ENGINE)).toThrow(CATALOG_UNREAD);
    expect(parse([])).toEqual([]);
});
