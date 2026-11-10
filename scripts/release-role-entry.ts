const roleArgument = process.argv[2];
const role = roleArgument?.startsWith("--vera-role=")
    ? roleArgument.slice("--vera-role=".length)
    : "cli";
if (role !== "cli" || roleArgument === "--vera-role=cli") {
    process.argv.splice(2, 1);
}

switch (role) {
    case "cli":
        await (await import("../clients/cli/main.ts")).runCliEntrypoint();
        break;
    case "tui":
        await (await import("../clients/tui/main.ts")).startConfiguredTui({
            type: "home",
            workspace: process.cwd(),
        });
        break;
    case "host":
        await (await import("../clients/host/main.ts")).runHostEntrypoint();
        break;
    case "session-worker":
        await (await import("../clients/host/session-worker.ts")).runSessionWorkerEntrypoint();
        break;
    case "worker":
        await (await import("../src/host/worker/entry.ts")).runWorkerEntrypoint();
        break;
    case "supervisor":
        await (await import("../src/host/worker-supervisor.ts")).runSupervisorEntrypoint();
        break;
    case "annex":
        await (await import("../src/annex/main.ts")).runAnnexEntrypoint();
        break;
    case "import":
        await import("../src/host/session-import-child.ts");
        break;
    case "watchdog":
        (await import("../clients/tui/flight-watchdog.ts")).runWatchdogEntrypoint();
        break;
    default:
        process.stderr.write(`Unknown Vera role: ${role}\n`);
        process.exitCode = 2;
}
