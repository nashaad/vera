import { expect, test } from "bun:test";
import { browserCommandAvailable } from "../../clients/ui/src/extensions/browser-command-rules.ts";

const page = { command: "example.page", title: "Select", page: true as const };
const task = { command: "example.task", title: "Task" };

test("only Browser page commands can run without a session", () => {
    expect(browserCommandAvailable(page, false, undefined)).toBe(true);
    expect(browserCommandAvailable(page, false, "preview-frame")).toBe(false);
    expect(browserCommandAvailable(task, false, undefined)).toBe(false);
    expect(browserCommandAvailable(task, true, undefined)).toBe(true);
    expect(browserCommandAvailable(page, true, "preview-frame")).toBe(true);
});
