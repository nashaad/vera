import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
    diagnoseProviders,
    renderProviderDoctor,
    type ProviderDoctorOptions,
} from "../clients/provider-doctor.ts";
import { createFailedRequestCapture } from "../src/providers/failed-request-capture.ts";
import type { StoredCredential } from "../src/providers/auth-storage.ts";

const CUSTOM_CONFIG = {
    providers: {
        "my-endpoint": {
            protocol: "openai-chat" as const,
            base_url: "https://llm.example.test/v1",
            credential: "api_key" as const,
            api_key_env: "MY_ENDPOINT_KEY",
        },
    },
};

function storage(
    credentials: Readonly<Record<string, StoredCredential>>,
): { getCredential(provider: string): StoredCredential | undefined } {
    return { getCredential: (provider) => credentials[provider] };
}

function base(options: ProviderDoctorOptions = {}): ProviderDoctorOptions {
    return {
        env: {},
        captureDirectory: join(tmpdir(), "vera-doctor-absent"),
        ...options,
    };
}

async function diagnose(id: string, options: ProviderDoctorOptions) {
    const report = await diagnoseProviders(CUSTOM_CONFIG, options);
    const provider = report.providers.find((entry) => entry.id === id);
    expect(provider).toBeDefined();
    return provider!;
}

test("a stored credential is reported as stored, not as the environment", async () => {
    const provider = await diagnose("my-endpoint", base({
        authStorage: storage({
            "my-endpoint": { type: "api_key", key: "sk-stored-value-1234" },
        }),
        env: { MY_ENDPOINT_KEY: "sk-env-value-5678" },
    }));

    expect(provider.connected).toBe(true);
    expect(provider.credentialSource).toBe("stored");
    expect(provider.envVarPresent).toBe(true);
    expect(provider.custom).toBe(true);
    expect(provider.endpoint).toEqual({
        baseUrl: "https://llm.example.test/v1",
        protocol: "openai-chat",
    });
});

test("an environment-only credential is named by its variable", async () => {
    const provider = await diagnose("my-endpoint", base({
        env: { MY_ENDPOINT_KEY: "sk-env-value-5678" },
    }));

    expect(provider.credentialSource).toBe("env");
    expect(provider.connected).toBe(true);
    expect(renderProviderDoctor({
        providers: [provider],
        networkChecked: false,
    })).toContain("Credential: from MY_ENDPOINT_KEY");
});

test("a provider with no credential at all says so", async () => {
    const provider = await diagnose("my-endpoint", base());

    expect(provider.credentialSource).toBe("none");
    expect(provider.connected).toBe(false);
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: false,
    });
    expect(rendered).toContain("no stored key, MY_ENDPOINT_KEY unset");
    expect(rendered).toContain("--check-providers");
});

test("an endpoint that cannot be reached is reported as unreachable", async () => {
    const provider = await diagnose("my-endpoint", base({
        checkNetwork: true,
        fetch: async () => {
            throw new Error("getaddrinfo ENOTFOUND llm.example.test");
        },
    }));

    expect(provider.probe?.reachability).toBe("unreachable");
    expect(provider.probe?.url).toBe("https://llm.example.test/v1/models");
    expect(renderProviderDoctor({
        providers: [provider],
        networkChecked: true,
    })).toContain("unreachable https://llm.example.test/v1/models");
});

test("a 401 is reported as reached but rejected", async () => {
    const provider = await diagnose("my-endpoint", base({
        checkNetwork: true,
        env: { MY_ENDPOINT_KEY: "sk-env-value-5678" },
        fetch: async () => new Response("no", { status: 401 }),
    }));

    expect(provider.probe?.reachability).toBe("rejected");
    expect(provider.probe?.status).toBe(401);
    expect(renderProviderDoctor({
        providers: [provider],
        networkChecked: true,
    })).toContain("which rejected the credential (HTTP 401)");
});

test("a 200 is reported as reached and authenticated", async () => {
    let seenHeaders: Record<string, string> = {};
    const provider = await diagnose("my-endpoint", base({
        checkNetwork: true,
        authStorage: storage({
            "my-endpoint": { type: "api_key", key: "sk-stored-value-1234" },
        }),
        fetch: async (_url, init) => {
            seenHeaders = (init?.headers ?? {}) as Record<string, string>;
            return new Response("{}", { status: 200 });
        },
    }));

    expect(provider.probe?.reachability).toBe("authenticated");
    expect(seenHeaders.authorization).toBe("Bearer sk-stored-value-1234");
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: true,
    });
    expect(rendered).toContain("which accepted the credential (HTTP 200)");
    expect(rendered).toContain("a real request is not tested");
});

test("a provider that does not list models is not reported as broken", async () => {
    const provider = await diagnose("my-endpoint", base({
        checkNetwork: true,
        env: { MY_ENDPOINT_KEY: "sk-env-value-5678" },
        fetch: async () => new Response("nope", { status: 404 }),
    }));

    expect(provider.probe?.reachability).toBe("models_unlisted");
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: true,
    });
    expect(rendered).toContain("does not list models (HTTP 404)");
    expect(rendered).toContain("not a fault");
    expect(rendered).not.toContain("rejected");
});

test("an anthropic-protocol probe sends x-api-key", async () => {
    let seenHeaders: Record<string, string> = {};
    await diagnoseProviders(
        {
            providers: {
                claudeish: {
                    protocol: "anthropic-messages",
                    base_url: "https://anth.example.test/v1",
                    credential: "api_key",
                    api_key_env: "CLAUDEISH_KEY",
                },
            },
        },
        base({
            checkNetwork: true,
            env: { CLAUDEISH_KEY: "abc-key-value" },
            fetch: async (url, init) => {
                if (String(url).startsWith("https://anth.example.test")) {
                    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
                }
                return new Response("{}", { status: 200 });
            },
        }),
    );

    expect(seenHeaders["x-api-key"]).toBe("abc-key-value");
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01");
});

test("recent failed-request captures are summarized from real capture files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-captures-"));
    const capture = createFailedRequestCapture({
        sessionId: "sess-1",
        directory,
        now: () => new Date("2026-08-17T10:00:00.000Z"),
    });
    const path = capture({
        provider: "my-endpoint",
        api: "chat",
        model: "gpt-oss-120b",
        outcome: "provider_error",
        error: "HTTP 422: unknown field `reasoning_effort`",
        request: { messages: [{ role: "user", content: "hi" }] },
        response: [{ chunk: 1 }],
    });
    expect(path).toBeDefined();

    const provider = await diagnose("my-endpoint", base({
        captureDirectory: directory,
    }));

    expect(provider.captures).toHaveLength(1);
    expect(provider.captures[0]).toMatchObject({
        timestamp: "2026-08-17T10:00:00.000Z",
        model: "gpt-oss-120b",
        outcome: "provider_error",
        error: "HTTP 422: unknown field `reasoning_effort`",
    });
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: false,
    });
    expect(rendered).toContain("Failed request 2026-08-17T10:00:00.000Z");
    expect(rendered).toContain("gpt-oss-120b");
});

test("a capture path under the home directory is abbreviated", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-home-"));
    const directory = join(home, "runtime", "logs", "captures");
    const capture = createFailedRequestCapture({
        sessionId: "sess-2",
        directory,
    });
    capture({
        provider: "my-endpoint",
        api: "chat",
        model: "m",
        outcome: "empty_response",
        request: {},
        response: [],
    });

    const provider = await diagnose("my-endpoint", base({
        captureDirectory: directory,
        homeDirectory: home,
    }));

    expect(provider.captures[0]?.path).toBe(
        "~/runtime/logs/captures/sess-2-1.json",
    );
    expect(provider.captures[0]?.path).not.toContain(home);
});

test("a capture path outside the supplied home is still abbreviated", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-home-"));
    const directory = await mkdtemp(join(tmpdir(), "vera-elsewhere-"));
    const capture = createFailedRequestCapture({
        sessionId: "sess-3",
        directory,
    });
    capture({
        provider: "my-endpoint",
        api: "chat",
        model: "m",
        outcome: "empty_response",
        request: {},
        response: [],
    });

    const provider = await diagnose("my-endpoint", base({
        captureDirectory: directory,
        homeDirectory: home,
    }));

    expect(provider.captures[0]?.path).toBe("<captures>/sess-3-1.json");
    expect(provider.captures[0]?.path).not.toContain(directory);
});

test("the rendered report never carries a secret, only the variable name", async () => {
    const secret = "sk-live-DEADBEEFdeadbeef0123456789";
    const directory = await mkdtemp(join(tmpdir(), "vera-captures-"));
    await writeFile(
        join(directory, "leak-1.json"),
        JSON.stringify({
            provider: "my-endpoint",
            timestamp: "2026-08-17T11:00:00.000Z",
            model: "m",
            outcome: "provider_error",
            error: `401 from upstream, sent Authorization: Bearer ${secret}`,
            request: { api_key: secret },
            response: [],
        }),
        "utf8",
    );

    const report = await diagnoseProviders(CUSTOM_CONFIG, base({
        captureDirectory: directory,
        checkNetwork: true,
        env: { MY_ENDPOINT_KEY: secret, ANTHROPIC_API_KEY: secret },
        authStorage: storage({
            openai: { type: "api_key", key: secret },
        }),
        fetch: async () => new Response("{}", { status: 401 }),
    }));
    const rendered = renderProviderDoctor(report);

    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("Bearer sk-");
    expect(rendered).toContain("MY_ENDPOINT_KEY");
    expect(rendered).toContain("[redacted]");
});

test("a base URL carrying credentials renders without them", async () => {
    const userinfo = "u5erN4me";
    const password = "p4ssW0rdInUserinfo";
    const query = "q3ueryStringSecretValue";
    const config = {
        providers: {
            "leaky-endpoint": {
                protocol: "openai-chat" as const,
                base_url:
                    `https://${userinfo}:${password}@llm.example.test/v1?key=${query}`,
                credential: "api_key" as const,
                api_key_env: "LEAKY_KEY",
            },
        },
    };

    const report = await diagnoseProviders(config, base({
        checkNetwork: true,
        env: { LEAKY_KEY: "sk-env-value-5678" },
        fetch: async () => new Response("{}", { status: 200 }),
    }));
    const rendered = renderProviderDoctor(report);

    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain(userinfo);
    expect(rendered).not.toContain(query);
    expect(rendered).toContain(
        "Endpoint: https://llm.example.test/v1?key=[redacted]",
    );
    expect(rendered).toContain("Network: reached https://llm.example.test");
});

test("a capture error carrying a credentialed URL renders without it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-captures-"));
    const userinfo = "u5erN4me";
    const password = "p4ssW0rdInUserinfo";
    const query = "q3ueryStringSecretValue";
    await writeFile(
        join(directory, "leak-2.json"),
        JSON.stringify({
            provider: "my-endpoint",
            timestamp: "2026-08-17T12:00:00.000Z",
            model: "m",
            outcome: "provider_error",
            error:
                `500 from https://${userinfo}:${password}@llm.example.test/v1/chat?key=${query}`,
            request: {},
            response: [],
        }),
        "utf8",
    );

    const provider = await diagnose("my-endpoint", base({
        captureDirectory: directory,
    }));
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: false,
    });

    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain(userinfo);
    expect(rendered).not.toContain(query);
    expect(rendered).toContain("https://llm.example.test/v1/chat?key=[redacted]");
});

test("redaction covers the credential shapes a capture error carries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-captures-"));
    const basicSecret = "pl4inBasicSecret123";
    const querySecret = "pl4inQuerySecret123";
    const tailSecret = "t4ilOfTheToken";
    await writeFile(
        join(directory, "shapes-1.json"),
        JSON.stringify({
            provider: "my-endpoint",
            timestamp: "2026-08-17T13:00:00.000Z",
            model: `m?key=${querySecret}`,
            outcome: `Authorization: Basic ${basicSecret}`,
            error: `sent Authorization: Bearer opaque:${tailSecret}`,
            request: {},
            response: [],
        }),
        "utf8",
    );

    const provider = await diagnose("my-endpoint", base({
        captureDirectory: directory,
    }));
    const rendered = renderProviderDoctor({
        providers: [provider],
        networkChecked: false,
    });

    expect(rendered).not.toContain(basicSecret);
    expect(rendered).not.toContain(querySecret);
    expect(rendered).not.toContain(tailSecret);
});

test("a base URL carrying a query string still probes the models path", async () => {
    // Concatenating onto such a URL puts `/models` inside the query, so the
    // probe would report on an address the provider never serves.
    let probed = "";
    await diagnoseProviders({
        providers: {
            "query-endpoint": {
                protocol: "openai-chat" as const,
                base_url: "https://llm.example.test/v1?region=eu",
                credential: "api_key" as const,
                api_key_env: "QUERY_ENDPOINT_KEY",
            },
        },
    }, base({
        checkNetwork: true,
        env: { QUERY_ENDPOINT_KEY: "sk-env-value-5678" },
        fetch: async (url) => {
            probed = String(url);
            return new Response("{}", { status: 200 });
        },
    }));

    expect(probed).toBe("https://llm.example.test/v1/models?region=eu");
});
