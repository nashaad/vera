import { expect, test } from "bun:test";

import { providerHttpDiagnostics, providerHttpError } from "../../src/providers/http-error.ts";

test("an HTTP failure keeps its status and body, and the provider's own words", async () => {
    const error = await providerHttpError("faux", Response.json({
        error: { type: "invalid_request_error", message: "The crow dropped the request in a storm." },
    }, { status: 400 }));

    expect(error.message).toStartWith("faux returned HTTP 400: {");
    expect(error.status).toBe(400);
    expect(providerHttpDiagnostics(error)).toEqual({
        providerMessage: "The crow dropped the request in a storm.",
        providerCode: "invalid_request_error",
    });
});

test("other common error bodies are read too, and anything else is left alone", async () => {
    const read = async (body: string) =>
        providerHttpDiagnostics(await providerHttpError("faux", new Response(body, { status: 500 })));

    expect(await read('{"message":"invalid key"}')).toEqual({ providerMessage: "invalid key" });
    expect(await read('{"error":"model not loaded"}')).toEqual({ providerMessage: "model not loaded" });
    expect(await read('{"error":{"code":"overloaded"}}')).toEqual({ providerCode: "overloaded" });
    expect(await read("<html>Bad Gateway</html>")).toEqual({});
    expect(await read("")).toEqual({});
    expect(providerHttpDiagnostics(new Error("no body"))).toEqual({});
});
