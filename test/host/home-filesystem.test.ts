import { expect, test } from "bun:test";

import { homeFilesystemProblem } from "../../src/host/home-filesystem.ts";

const WSL_MOUNTS = [
    "/dev/sdc / ext4 rw,relatime 0 0",
    "C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs 0 0",
    "none /mnt/wsl tmpfs rw 0 0",
].join("\n");

test("a home on a WSL Windows drive is reported with the fix", () => {
    const problem = homeFilesystemProblem("/mnt/c/Users/a/.vera", WSL_MOUNTS);
    expect(problem).toContain("Windows drive (/mnt/c, 9p)");
    expect(problem).toContain("VERA_HOME");
});

test("a home in the Linux filesystem is fine", () => {
    expect(homeFilesystemProblem("/home/a/.vera", WSL_MOUNTS)).toBeUndefined();
    expect(homeFilesystemProblem("/mnt/cx/.vera", WSL_MOUNTS)).toBeUndefined();
});
