const fetchLocal = globalThis.fetch.bind(globalThis);

globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
        return fetchLocal(input, init);
    }
    const port = process.env.POOL_TEST_STUB_PORT;
    if (port === undefined) throw new Error("Local provider stub is unavailable");
    return fetchLocal(`http://127.0.0.1:${port}${url.pathname}`, init);
}) as typeof globalThis.fetch;
