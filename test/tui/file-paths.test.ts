import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePathMentions } from "../../clients/tui/file-paths.ts";
import { prepareTuiFileText } from "../../clients/tui/file-preparation.ts";

test("finds existing quoted and escaped paths without treating images as files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vera-tui-file-"));
    try {
        const path = join(dir, "crow report.txt");
        const image = join(dir, "crow.png");
        writeFileSync(path, "crow");
        writeFileSync(image, "image");
        expect(filePathMentions(`read "${path}" and ${image}`)).toEqual([{ text: `"${path}"`, path }]);
        expect(filePathMentions(path.replaceAll(" ", "\\ "))[0]?.path).toBe(path);
        expect(filePathMentions(path)[0]?.path).toBe(path);
        expect(filePathMentions("/path/that/does/not/exist")).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("prepares a terminal path through the same chat copy and folder reference rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vera-tui-prepare-"));
    try {
        const chat = join(dir, "chat");
        mkdirSync(chat);
        const source = join(dir, "report.txt");
        writeFileSync(source, "report");
        expect(await prepareTuiFileText(`Read ${source}`, { workspace: chat, chat: true }, 0))
            .toBe('Read "report.txt"\n\nAttached files:\n- "report.txt"');
        expect(readFileSync(join(chat, "report.txt"), "utf8")).toBe("report");
        expect(await prepareTuiFileText(`Read ${source}`, { workspace: dir, chat: false }, 0))
            .toBe('Read "report.txt"\n\nAttached files:\n- "report.txt"');
        const other = join(dir, "report.txt.more");
        writeFileSync(other, "other");
        const both = await prepareTuiFileText(`Read ${source} ${other}`, { workspace: dir, chat: false }, 0);
        expect(both).toBe('Read "report.txt" "report.txt.more"\n\nAttached files:\n- "report.txt"\n- "report.txt.more"');
        await expect(prepareTuiFileText(`Read ${source}`, { workspace: dir, chat: false }, 8)).rejects.toThrow("up to 8");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
