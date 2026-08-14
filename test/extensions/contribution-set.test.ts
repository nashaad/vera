import { expect, test } from "bun:test";

import {
    ContributionCollisionError,
    createHostContributionSet,
} from "../../src/extensions/contribution-set.ts";
import { parseExtensionContributions } from "../../src/extensions/contributions.ts";

function watches(extensionId: string, ...ids: readonly string[]) {
    return parseExtensionContributions({
        watches: ids.map((id) => ({ id, source_family: "arc" })),
    }, extensionId);
}

test("every admitted contribution carries its owner and canonical id", () => {
    const set = createHostContributionSet();
    set.admit("acme.arc-bridge", watches("acme.arc-bridge", "main", "side"), "/ext/acme");

    expect(set.watches().map((entry) => entry.id)).toEqual([
        "acme.arc-bridge/main",
        "acme.arc-bridge/side",
    ]);
    expect(set.watch("acme.arc-bridge/main")?.extensionId)
        .toBe("acme.arc-bridge");
    expect(set.watch("acme.arc-bridge/main")?.localId).toBe("main");
});

test("two extensions may use the same local watch id", () => {
    const set = createHostContributionSet();
    set.admit("acme.arc-bridge", watches("acme.arc-bridge", "main"), "/ext/acme");
    set.admit("other.bridge", watches("other.bridge", "main"), "/ext/other");

    expect(set.watches().map((entry) => entry.id)).toEqual([
        "acme.arc-bridge/main",
        "other.bridge/main",
    ]);
});

test("a canonical id collision names both extensions and admits nothing", () => {
    const set = createHostContributionSet();
    set.admit("acme.arc-bridge", watches("acme.arc-bridge", "main"), "/ext/acme");

    expect(() => set.admit(
        "acme.arc-bridge",
        watches("acme.arc-bridge", "other", "main"),
        "/ext/acme",
    )).toThrow(ContributionCollisionError);
    expect(set.watches().map((entry) => entry.id))
        .toEqual(["acme.arc-bridge/main"]);
});

test("the set refuses contributions once the load phase is frozen", () => {
    const set = createHostContributionSet();
    set.freeze();

    expect(set.frozen()).toBe(true);
    expect(() => set.admit("acme.arc-bridge", watches("acme.arc-bridge", "main"), "/ext/acme"))
        .toThrow(/frozen/);
});

test("withdrawal returns an extension's contributions in reverse order", () => {
    const set = createHostContributionSet();
    set.admit("acme.arc-bridge", watches("acme.arc-bridge", "one", "two"), "/ext/acme");
    set.admit("other.bridge", watches("other.bridge", "three"), "/ext/other");
    set.freeze();

    expect(set.withdraw("acme.arc-bridge").map((entry) => entry.localId))
        .toEqual(["two", "one"]);
    expect(set.watches().map((entry) => entry.id))
        .toEqual(["other.bridge/three"]);
});
