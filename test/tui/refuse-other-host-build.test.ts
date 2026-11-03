import { expect, test } from "bun:test";

import { refuseOtherHostBuild } from "../../clients/tui/configured-agent-client.ts";
import { HostBuildChangedError } from "../../src/host/reconnecting-agent-client.ts";

test("Reconnect host refuses a live host of another build before discovery runs", async () => {
    const refused = await refuseOtherHostBuild("vera-crow-1", async () => "vera-kraken-2").catch((error) => error);
    expect(refused).toBeInstanceOf(HostBuildChangedError);
    expect(refused).toMatchObject({ clientBuildId: "vera-crow-1", hostBuildId: "vera-kraken-2" });
});

test("Reconnect host goes ahead when the live host is this build or there is no live host", async () => {
    await refuseOtherHostBuild("vera-crow-1", async () => "vera-crow-1");
    await refuseOtherHostBuild("vera-crow-1", async () => undefined);
});
