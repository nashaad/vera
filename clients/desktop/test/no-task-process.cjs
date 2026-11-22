const { utilityProcess } = require("electron");

utilityProcess.fork = () => {
    throw new Error("This trial does not start utility task processes.");
};
