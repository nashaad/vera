import { expect, test } from "bun:test";
import { shouldRestoreAfterClientSignal } from "../../scripts/dev-tui-client.ts";

test("development launcher restores only unhandled signal exits on a tty", () => {
    expect(shouldRestoreAfterClientSignal(null, true)).toBe(false);
    expect(shouldRestoreAfterClientSignal("SIGKILL", false)).toBe(false);
    expect(shouldRestoreAfterClientSignal("SIGKILL", true)).toBe(true);
    expect(shouldRestoreAfterClientSignal("SIGSEGV", true)).toBe(true);
    expect(shouldRestoreAfterClientSignal("SIGHUP", true)).toBe(false);
    expect(shouldRestoreAfterClientSignal("SIGQUIT", true)).toBe(false);
    expect(shouldRestoreAfterClientSignal("SIGTERM", true)).toBe(false);
});
