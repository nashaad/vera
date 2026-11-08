import { createTestRenderer } from "@opentui/core/testing";

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

export async function waitForRender(setup: Setup, ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 3500;
    do {
        await setup.flush();
        if (ready()) return;
        await Bun.sleep(20);
    } while (Date.now() < deadline);
    throw new Error(`render did not settle:\n${setup.captureCharFrame()}`);
}
