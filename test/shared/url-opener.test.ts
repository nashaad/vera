import { describe, expect, test } from "bun:test";

import { isWsl, urlOpenerCommand } from "../../src/url-opener.ts";

const URL = "https://auth.example/sign-in";
const PLAIN_LINUX = "Linux version 6.8.0-45-generic (buildd@debian)";
const WSL_KERNEL = "Linux version 6.6.114.1-microsoft-standard-WSL2";

describe("URL opener command", () => {
    test("uses xdg-open on plain Linux", () => {
        expect(
            urlOpenerCommand(URL, {
                platform: "linux",
                env: {},
                procVersion: PLAIN_LINUX,
            }),
        ).toEqual(["xdg-open", URL]);
    });

    test("uses wslview on WSL when it is installed", () => {
        expect(
            urlOpenerCommand(URL, {
                platform: "linux",
                env: { WSL_DISTRO_NAME: "Ubuntu" },
                procVersion: PLAIN_LINUX,
                hasCommand: (command) => command === "wslview",
            }),
        ).toEqual(["wslview", URL]);
    });

    test("falls back to explorer.exe on WSL without wslview", () => {
        expect(
            urlOpenerCommand(URL, {
                platform: "linux",
                env: { WSL_DISTRO_NAME: "Ubuntu" },
                procVersion: PLAIN_LINUX,
                hasCommand: () => false,
            }),
        ).toEqual(["explorer.exe", URL]);
    });

    test("detects WSL from the kernel string when no marker is set", () => {
        expect(isWsl({}, WSL_KERNEL)).toBe(true);
        expect(
            urlOpenerCommand(URL, {
                platform: "linux",
                env: {},
                procVersion: WSL_KERNEL,
                hasCommand: () => false,
            }),
        ).toEqual(["explorer.exe", URL]);
    });

    test("plain Linux is not WSL", () => {
        expect(isWsl({}, PLAIN_LINUX)).toBe(false);
    });

    test("uses open on macOS", () => {
        expect(
            urlOpenerCommand(URL, {
                platform: "darwin",
                env: {},
                procVersion: PLAIN_LINUX,
            }),
        ).toEqual(["open", URL]);
    });

    test("uses explorer.exe on Windows", () => {
        expect(
            urlOpenerCommand(URL, {
                platform: "win32",
                env: {},
                procVersion: PLAIN_LINUX,
            }),
        ).toEqual(["explorer.exe", URL]);
    });
});
