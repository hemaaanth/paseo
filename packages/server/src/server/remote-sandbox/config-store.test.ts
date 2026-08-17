import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRemoteSandboxConfigStore } from "./config-store.js";

describe("remote sandbox config store", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-rsc-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("redacted view exposes 'configured' booleans, never the secret", () => {
    const store = createRemoteSandboxConfigStore({ paseoHome: home });
    store.update({
      daytonaApiKey: "dtn_supersecret",
      daytonaApiUrl: "https://app.daytona.io/api",
      tailscaleAuthKey: "tskey-secret",
      image: "snapshot:paseo-1",
    });

    const redacted = store.redacted();
    expect(redacted.daytonaApiKeyConfigured).toBe(true);
    expect(redacted.tailscaleAuthKeyConfigured).toBe(true);
    expect(redacted.tailscaleOauthClientSecretConfigured).toBe(false);
    expect(redacted.daytonaApiUrl).toBe("https://app.daytona.io/api");
    expect(redacted.image).toBe("snapshot:paseo-1");
    // No secret value leaks into the redacted view.
    expect(JSON.stringify(redacted)).not.toContain("dtn_supersecret");
    expect(JSON.stringify(redacted)).not.toContain("tskey-secret");

    // But the daemon-side read() keeps the raw secret (that's how it provisions).
    expect(store.read().daytonaApiKey).toBe("dtn_supersecret");
  });

  test("update keeps omitted keys — write-only secrets survive an unrelated save", () => {
    const store = createRemoteSandboxConfigStore({ paseoHome: home });
    store.update({ daytonaApiKey: "k1", image: "snapshot:a" });
    // The settings UI saves without re-sending the key it isn't changing.
    store.update({ image: "snapshot:b" });
    expect(store.read().daytonaApiKey).toBe("k1");
    expect(store.read().image).toBe("snapshot:b");
  });

  test("persists across store instances (same home)", () => {
    createRemoteSandboxConfigStore({ paseoHome: home }).update({ daytonaApiKey: "persisted" });
    const reopened = createRemoteSandboxConfigStore({ paseoHome: home });
    expect(reopened.read().daytonaApiKey).toBe("persisted");
  });
});
