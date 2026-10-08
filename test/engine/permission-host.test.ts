import { expect, test } from "bun:test";

import {
    hostMatches,
    isHostPattern,
    urlHost,
} from "../../src/engine/permission-host.ts";

test("urlHost keeps the hostname and drops everything else", () => {
    expect(urlHost("https://GitHub.com/x")).toBe("github.com");
    expect(urlHost("https://github.com:8443/x")).toBe("github.com");
    expect(urlHost("https://evil.example./x")).toBe("evil.example");
    expect(urlHost("https://evil.example../x")).toBe("evil.example");
    expect(urlHost("https://user:pw@github.com/")).toBe("github.com");
    expect(urlHost("https://bücher.example/")).toBe("xn--bcher-kva.example");
    expect(urlHost("https://[::1]:8080/")).toBe("[::1]");
    expect(urlHost("ftp://github.com/x")).toBeUndefined();
    expect(urlHost("not a url")).toBeUndefined();
});

test("isHostPattern accepts only hostnames URL parsing would leave alone", () => {
    for (const pattern of [
        "github.com",
        "*.github.com",
        "GitHub.com",
        "[::1]",
        "127.0.0.1",
        "xn--bcher-kva.example",
    ]) {
        expect(isHostPattern(pattern)).toBe(true);
    }
    for (const pattern of [
        "",
        "*",
        "*.",
        "git*.com",
        "**.github.com",
        "a.*.com",
        "github.com/x",
        "github.com:443",
        " github.com",
        "user@github.com",
        "github.com?x",
        "bücher.example",
        "0x7f.1",
        ".github.com",
        "github..com",
        "github.com.",
        "*.[::1]",
        42,
    ]) {
        expect(isHostPattern(pattern)).toBe(false);
    }
});

test("hostMatches compares exact hosts and any-depth subdomains", () => {
    expect(hostMatches("github.com", "github.com")).toBe(true);
    expect(hostMatches("github.com", "api.github.com")).toBe(false);
    expect(hostMatches("*.github.com", "api.github.com")).toBe(true);
    expect(hostMatches("*.github.com", "a.b.github.com")).toBe(true);
    expect(hostMatches("*.github.com", "github.com")).toBe(false);
    expect(hostMatches("*.github.com", "evilgithub.com")).toBe(false);
    expect(hostMatches("GitHub.com", "github.com")).toBe(true);
    expect(hostMatches("github.com", undefined)).toBe(false);
    expect(hostMatches("*.github.com", undefined)).toBe(false);
});
