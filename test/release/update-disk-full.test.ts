import { expect, test } from "bun:test";

import { diskFullError } from "../../src/release/update.ts";

test("@core a full disk during an update reads as a plain sentence", () => {
    const write = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const mapped = diskFullError(write, "0.1.0");
    expect(mapped?.message).toBe("Not enough disk space to download Vera 0.1.0.");
    expect(mapped?.cause).toBe(write);
    expect(diskFullError(new Error("tar: Write failed: No space left on device"), "0.1.0")?.message)
        .toBe("Not enough disk space to download Vera 0.1.0.");
    expect(diskFullError(new Error("Checksum mismatch for vera-darwin-arm64.tar.gz."), "0.1.0")).toBeUndefined();
    expect(diskFullError("ENOSPCX", "0.1.0")).toBeUndefined();
});
