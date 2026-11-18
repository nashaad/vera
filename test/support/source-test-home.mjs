import { mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutPack = fileURLToPath(new URL("../../dist/release", import.meta.url));

export function sourceTestHome(home) {
    const current = join(home, ".local", "share", "vera", "current");
    mkdirSync(dirname(current), { recursive: true });
    // Development children use source when the checkout pack is the installed release.
    try {
        symlinkSync(checkoutPack, current, "dir");
    } catch (error) {
        if (error.code !== "EEXIST" || readlinkSync(current) !== checkoutPack) throw error;
    }
    return home;
}
