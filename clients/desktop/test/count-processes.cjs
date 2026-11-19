// Loaded with -r ahead of the app's main script, so every utility process the app starts is counted
// by its service name from the first line of main on. Read the counts with globalThis.utilityStarts.
const { utilityProcess } = require("electron");

const fork = utilityProcess.fork.bind(utilityProcess);
globalThis.utilityStarts = {};
utilityProcess.fork = (modulePath, args, options) => {
    const name = options?.serviceName ?? "";
    globalThis.utilityStarts[name] = (globalThis.utilityStarts[name] ?? 0) + 1;
    return fork(modulePath, args, options);
};
