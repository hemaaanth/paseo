import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolvePaseoHome } from "../paseo-home.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const CONFIG_FILENAME = "remote-sandbox-config.json";

/**
 * Remote-sandbox provider config, persisted daemon-side (0600). Holds secrets in
 * plaintext on the daemon's own disk — the same trust boundary as the env vars it
 * replaces. Secrets are NEVER sent to clients; only the redacted view is.
 * `provider` is framework-ready (daytona today; e2b/modal/… later).
 */
export interface RemoteSandboxConfig {
  provider?: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  tailscaleAuthKey?: string;
  tailscaleOauthClientId?: string;
  tailscaleOauthClientSecret?: string;
  tailscaleTag?: string;
  image?: string;
}

/** What clients see: secret values become "configured" booleans. */
export interface RedactedRemoteSandboxConfig {
  provider?: string;
  daytonaApiUrl?: string;
  daytonaApiKeyConfigured: boolean;
  tailscaleAuthKeyConfigured: boolean;
  tailscaleOauthClientId?: string;
  tailscaleOauthClientSecretConfigured: boolean;
  tailscaleTag?: string;
  image?: string;
}

export interface RemoteSandboxConfigStore {
  read(): RemoteSandboxConfig;
  redacted(): RedactedRemoteSandboxConfig;
  /** Merge a patch: defined keys overwrite, absent keys are kept (write-only for
   *  secrets — the UI omits a secret it isn't changing, so it stays put). */
  update(patch: RemoteSandboxConfig): RedactedRemoteSandboxConfig;
}

function redact(config: RemoteSandboxConfig): RedactedRemoteSandboxConfig {
  return {
    provider: config.provider,
    daytonaApiUrl: config.daytonaApiUrl,
    daytonaApiKeyConfigured: Boolean(config.daytonaApiKey),
    tailscaleAuthKeyConfigured: Boolean(config.tailscaleAuthKey),
    tailscaleOauthClientId: config.tailscaleOauthClientId,
    tailscaleOauthClientSecretConfigured: Boolean(config.tailscaleOauthClientSecret),
    tailscaleTag: config.tailscaleTag,
    image: config.image,
  };
}

export function createRemoteSandboxConfigStore(options?: {
  paseoHome?: string;
}): RemoteSandboxConfigStore {
  const paseoHome = options?.paseoHome ?? resolvePaseoHome();
  const filePath = path.join(paseoHome, CONFIG_FILENAME);

  function read(): RemoteSandboxConfig {
    if (!existsSync(filePath)) {
      return {};
    }
    try {
      ensurePrivateFile(filePath);
      return JSON.parse(readFileSync(filePath, "utf8")) as RemoteSandboxConfig;
    } catch {
      return {};
    }
  }

  return {
    read,
    redacted: () => redact(read()),
    update: (patch) => {
      const next: RemoteSandboxConfig = { ...read() };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      writePrivateFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
      return redact(next);
    },
  };
}

// Daemon-global singleton — one config file per PASEO_HOME.
let sharedStore: RemoteSandboxConfigStore | null = null;
export function getRemoteSandboxConfigStore(): RemoteSandboxConfigStore {
  if (!sharedStore) {
    sharedStore = createRemoteSandboxConfigStore();
  }
  return sharedStore;
}
