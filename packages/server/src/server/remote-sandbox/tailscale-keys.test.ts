import { describe, expect, test } from "vitest";

import { createTailscaleKeyMinter } from "./tailscale-keys.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createTailscaleKeyMinter", () => {
  test("exchanges client creds for a token, then mints a tagged ephemeral key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/oauth/token")) return jsonResponse({ access_token: "at-123" });
      return jsonResponse({ key: "tskey-minted" });
    }) as unknown as typeof fetch;

    const mint = createTailscaleKeyMinter({
      clientId: "cid",
      clientSecret: "secret",
      tags: ["tag:paseo-sandbox"],
      fetchImpl,
    });
    const key = await mint();

    expect(key).toBe("tskey-minted");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/oauth/token");
    // second call authenticates with the exchanged token and requests an ephemeral tagged key
    const keysCall = calls[1];
    if (!keysCall) throw new Error("expected a second (key mint) call");
    expect(keysCall.url).toContain("/tailnet/-/keys");
    const authHeader = (keysCall.init.headers as Record<string, string>).authorization;
    expect(authHeader).toBe("Bearer at-123");
    const body = JSON.parse(keysCall.init.body as string);
    expect(body.capabilities.devices.create).toMatchObject({
      ephemeral: true,
      reusable: false,
      preauthorized: true,
      tags: ["tag:paseo-sandbox"],
    });
  });

  test("throws when the token exchange fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const mint = createTailscaleKeyMinter({
      clientId: "cid",
      clientSecret: "bad",
      tags: ["tag:paseo-sandbox"],
      fetchImpl,
    });
    await expect(mint()).rejects.toThrow(/oauth token failed: 401/);
  });
});
