// Loaded with -r ahead of the app's main script, so every utility process the app starts is counted
// by its service name from the first line of main on. Read the counts with globalThis.utilityStarts.
const { utilityProcess } = require("electron");

const fork = utilityProcess.fork.bind(utilityProcess);
globalThis.utilityStarts = {};
globalThis.utilityLive = {};
globalThis.utilityMax = {};
globalThis.utilityTimes = {};
utilityProcess.fork = (modulePath, args, options) => {
    const name = options?.serviceName ?? "";
    globalThis.utilityStarts[name] = (globalThis.utilityStarts[name] ?? 0) + 1;
    globalThis.utilityLive[name] = (globalThis.utilityLive[name] ?? 0) + 1;
    globalThis.utilityMax[name] = Math.max(globalThis.utilityMax[name] ?? 0, globalThis.utilityLive[name]);
    const startedAt = performance.now();
    const child = fork(modulePath, args, options);
    child.once("exit", () => {
        globalThis.utilityLive[name] -= 1;
        (globalThis.utilityTimes[name] ??= []).push(performance.now() - startedAt);
    });
    return child;
};
