import { randomUUID } from "node:crypto";

import type {
  RemoteSandboxConfigGetRequest,
  RemoteSandboxConfigSetRequest,
  RemoteSandboxProvisionRequest,
  RemoteSandboxResumeRequest,
  RemoteSandboxStatusRequest,
  RemoteSandboxTeardownRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import { getRemoteSandboxConfigStore } from "./config-store.js";
import { createDaytonaHost } from "./daytona-host.js";
import { resolveGitOriginUrl } from "./git-origin.js";
import { createRemoteSandboxProvisioner, type RemoteSandboxProvisioner } from "./provisioner.js";
import { createTailscaleKeyMinter } from "./tailscale-keys.js";

interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface RemoteSandboxSessionDeps {
  emit(message: SessionOutboundMessage): void;
  logger: Logger;
  /** Injectable for tests; defaults to an env-configured provisioner (or null). */
  provisioner?: RemoteSandboxProvisioner | null;
  /** Injectable for tests; defaults to resolving the git origin of the cwd. */
  resolveOriginUrl?: (cwd: string) => Promise<string>;
}

/**
 * Effective creds: the saved settings config wins, env vars are the fallback (dev
 * + backwards compat). Reads the config file fresh so settings changes apply
 * without restarting the daemon.
 */
function resolveCreds(): {
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  tailscaleAuthKey?: string;
  tailscaleOauthClientId?: string;
  tailscaleOauthClientSecret?: string;
  tailscaleTag?: string;
  image?: string;
} {
  const c = getRemoteSandboxConfigStore().read();
  const env = process.env;
  return {
    daytonaApiKey: c.daytonaApiKey || env["DAYTONA_API_KEY"],
    daytonaApiUrl: c.daytonaApiUrl || env["DAYTONA_API_URL"],
    tailscaleAuthKey: c.tailscaleAuthKey || env["TAILSCALE_AUTH_KEY"],
    tailscaleOauthClientId: c.tailscaleOauthClientId || env["TAILSCALE_OAUTH_CLIENT_ID"],
    tailscaleOauthClientSecret:
      c.tailscaleOauthClientSecret || env["TAILSCALE_OAUTH_CLIENT_SECRET"],
    tailscaleTag: c.tailscaleTag || env["TAILSCALE_TAG"],
    image: c.image || env["PASEO_SANDBOX_IMAGE"],
  };
}

/** Whether this daemon has the creds (settings or env) to provision sandboxes. */
export function isRemoteSandboxConfigured(): boolean {
  const creds = resolveCreds();
  if (!creds.daytonaApiKey) return false;
  return Boolean(
    creds.tailscaleAuthKey || (creds.tailscaleOauthClientId && creds.tailscaleOauthClientSecret),
  );
}

/**
 * Build a provisioner from the effective creds, or null if unconfigured. A static
 * reusable key (tailscaleAuthKey) is used directly; otherwise per-box OAuth
 * minting (tailscaleOauthClientId/_Secret).
 */
export function buildProvisioner(logger: Logger): RemoteSandboxProvisioner | null {
  const creds = resolveCreds();
  if (!creds.daytonaApiKey) return null;

  let mintTailnetKey: (() => Promise<string>) | null = null;
  if (creds.tailscaleAuthKey) {
    const key = creds.tailscaleAuthKey;
    mintTailnetKey = () => Promise.resolve(key);
  } else if (creds.tailscaleOauthClientId && creds.tailscaleOauthClientSecret) {
    mintTailnetKey = createTailscaleKeyMinter({
      clientId: creds.tailscaleOauthClientId,
      clientSecret: creds.tailscaleOauthClientSecret,
      tags: [creds.tailscaleTag ?? "tag:paseo-sandbox"],
    });
  }
  if (!mintTailnetKey) return null;

  return createRemoteSandboxProvisioner({
    host: createDaytonaHost({ apiKey: creds.daytonaApiKey, apiUrl: creds.daytonaApiUrl }),
    logger,
    image: creds.image ?? "paseo-sandbox:0.4.0",
    mintTailnetKey,
    corsOrigins: process.env["PASEO_SANDBOX_CORS_ORIGINS"],
  });
}

/**
 * Delegating session handler for the remote-sandbox RPCs. Mirrors the schedule
 * session: the daemon session dispatches to it and it emits outbound messages.
 * All logic stays here (fork-isolated); session.ts only routes.
 */
export class RemoteSandboxSession {
  private readonly resolveOriginUrl: (cwd: string) => Promise<string>;

  constructor(private readonly deps: RemoteSandboxSessionDeps) {
    this.resolveOriginUrl = deps.resolveOriginUrl ?? resolveGitOriginUrl;
  }

  // Built fresh per access so a settings change applies without reconnecting;
  // an injected provisioner (tests) still wins.
  private get provisioner(): RemoteSandboxProvisioner | null {
    return this.deps.provisioner !== undefined
      ? this.deps.provisioner
      : buildProvisioner(this.deps.logger);
  }

  async handleProvisionRequest(message: RemoteSandboxProvisionRequest): Promise<void> {
    const { requestId, cwd, branch } = message.payload;
    const provisionId = randomUUID();
    if (!this.provisioner) {
      this.deps.emit({
        type: "remote.sandbox.provision.response",
        payload: {
          requestId,
          provisionId,
          error: "remote sandbox is not configured on this daemon",
        },
      });
      return;
    }
    // Ack fast (well under the 60s RPC timeout); progress streams separately.
    this.deps.emit({
      type: "remote.sandbox.provision.response",
      payload: { requestId, provisionId, error: null },
    });
    void this.runProvision(provisionId, { cwd, branch });
  }

  private async runProvision(
    provisionId: string,
    request: { cwd: string; branch?: string },
  ): Promise<void> {
    const provisioner = this.provisioner;
    if (!provisioner) return;
    try {
      const repoUrl = await this.resolveOriginUrl(request.cwd);
      const result = await provisioner.provision(
        { repoUrl, branch: request.branch },
        (progress) => {
          this.deps.emit({
            type: "remote.sandbox.provision.progress",
            payload: {
              provisionId,
              status: "running",
              step: progress.step,
              detail: progress.detail,
              error: null,
            },
          });
        },
      );
      this.deps.emit({
        type: "remote.sandbox.provision.progress",
        payload: {
          provisionId,
          status: "completed",
          error: null,
          connection: {
            sandboxId: result.sandboxId,
            tailnetIp: result.tailnetIp,
            magicDns: result.magicDns,
            password: result.password,
          },
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ err: error, provisionId }, "remote sandbox provision failed");
      this.deps.emit({
        type: "remote.sandbox.provision.progress",
        payload: { provisionId, status: "failed", error: detail },
      });
    }
  }

  async handleTeardownRequest(message: RemoteSandboxTeardownRequest): Promise<void> {
    const { requestId, sandboxId } = message.payload;
    if (!this.provisioner) {
      this.deps.emit({
        type: "remote.sandbox.teardown.response",
        payload: { requestId, error: "remote sandbox is not configured on this daemon" },
      });
      return;
    }
    try {
      await this.provisioner.teardown(sandboxId);
      this.deps.emit({
        type: "remote.sandbox.teardown.response",
        payload: { requestId, error: null },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.emit({
        type: "remote.sandbox.teardown.response",
        payload: { requestId, error: detail },
      });
    }
  }

  async handleStatusRequest(message: RemoteSandboxStatusRequest): Promise<void> {
    const { requestId, sandboxId } = message.payload;
    if (!this.provisioner) {
      this.deps.emit({
        type: "remote.sandbox.status.response",
        payload: { requestId, status: "unknown", error: "remote sandbox is not configured" },
      });
      return;
    }
    try {
      const status = await this.provisioner.status(sandboxId);
      this.deps.emit({
        type: "remote.sandbox.status.response",
        payload: { requestId, status, error: null },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.emit({
        type: "remote.sandbox.status.response",
        payload: { requestId, status: "unknown", error: detail },
      });
    }
  }

  async handleResumeRequest(message: RemoteSandboxResumeRequest): Promise<void> {
    const { requestId, sandboxId } = message.payload;
    if (!this.provisioner) {
      this.deps.emit({
        type: "remote.sandbox.resume.response",
        payload: { requestId, error: "remote sandbox is not configured" },
      });
      return;
    }
    try {
      await this.provisioner.resume(sandboxId);
      this.deps.emit({
        type: "remote.sandbox.resume.response",
        payload: { requestId, error: null },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.emit({
        type: "remote.sandbox.resume.response",
        payload: { requestId, error: detail },
      });
    }
  }

  async handleConfigGetRequest(message: RemoteSandboxConfigGetRequest): Promise<void> {
    this.deps.emit({
      type: "remote.sandbox.config.get.response",
      payload: {
        requestId: message.payload.requestId,
        config: getRemoteSandboxConfigStore().redacted(),
      },
    });
  }

  async handleConfigSetRequest(message: RemoteSandboxConfigSetRequest): Promise<void> {
    const { requestId, patch } = message.payload;
    try {
      const config = getRemoteSandboxConfigStore().update(patch);
      this.deps.emit({
        type: "remote.sandbox.config.set.response",
        payload: { requestId, config, error: null },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.emit({
        type: "remote.sandbox.config.set.response",
        payload: { requestId, config: getRemoteSandboxConfigStore().redacted(), error: detail },
      });
    }
  }
}
