/**
 * Mint a fresh ephemeral, tagged Tailscale auth key per box from a Tailscale
 * OAuth client. OAuth-minted keys must be tagged — that is the point: sandbox
 * nodes get `tag:paseo-sandbox` and ACLs scope what they can reach.
 *
 * NOTE: the OAuth mint path is not yet exercised against the live API — dev uses
 * the static reusable-key path (TAILSCALE_AUTH_KEY) in remote-sandbox-route.ts.
 * Verify the two request shapes against Tailscale's API before relying on it.
 */

const OAUTH_TOKEN_URL = "https://api.tailscale.com/api/v2/oauth/token";
const KEYS_URL = "https://api.tailscale.com/api/v2/tailnet/-/keys";

export interface TailscaleKeyMinterOptions {
  clientId: string;
  clientSecret: string;
  /** Tags the OAuth client is authorized for, e.g. ["tag:paseo-sandbox"]. */
  tags: string[];
  expirySeconds?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface OAuthTokenResponse {
  access_token: string;
}

interface CreateKeyResponse {
  key: string;
}

export function createTailscaleKeyMinter(
  options: TailscaleKeyMinterOptions,
): () => Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;

  return async (): Promise<string> => {
    const tokenRes = await doFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`tailscale oauth token failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { access_token: accessToken } = (await tokenRes.json()) as OAuthTokenResponse;

    const keyRes = await doFetch(KEYS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: { reusable: false, ephemeral: true, preauthorized: true, tags: options.tags },
          },
        },
        expirySeconds: options.expirySeconds ?? 3600,
        description: "paseo remote sandbox",
      }),
    });
    if (!keyRes.ok) {
      throw new Error(`tailscale key mint failed: ${keyRes.status} ${await keyRes.text()}`);
    }
    const { key } = (await keyRes.json()) as CreateKeyResponse;
    return key;
  };
}
