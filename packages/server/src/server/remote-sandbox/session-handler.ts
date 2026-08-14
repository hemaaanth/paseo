import { randomUUID } from "node:crypto";

import type {
  RemoteSandboxProvisionRequest,
  RemoteSandboxTeardownRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

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

/** Whether this daemon has the env creds to provision remote sandboxes. */
export function isRemoteSandboxConfigured(): boolean {
  const env = process.env;
  if (!env["DAYTONA_API_KEY"]) return false;
  return Boolean(
    env["TAILSCALE_AUTH_KEY"] ||
    (env["TAILSCALE_OAUTH_CLIENT_ID"] && env["TAILSCALE_OAUTH_CLIENT_SECRET"]),
  );
}

/**
 * Build a provisioner from env creds, or null if this daemon isn't configured
 * for remote sandboxes. Dev uses the static reusable key (TAILSCALE_AUTH_KEY);
 * prod uses per-box OAuth minting (TAILSCALE_OAUTH_CLIENT_ID/_SECRET).
 */
export function buildEnvProvisioner(logger: Logger): RemoteSandboxProvisioner | null {
  const env = process.env;
  const daytonaApiKey = env["DAYTONA_API_KEY"];
  if (!daytonaApiKey) return null;

  let mintTailnetKey: (() => Promise<string>) | null = null;
  const staticKey = env["TAILSCALE_AUTH_KEY"];
  const clientId = env["TAILSCALE_OAUTH_CLIENT_ID"];
  const clientSecret = env["TAILSCALE_OAUTH_CLIENT_SECRET"];
  if (staticKey) {
    mintTailnetKey = () => Promise.resolve(staticKey);
  } else if (clientId && clientSecret) {
    mintTailnetKey = createTailscaleKeyMinter({
      clientId,
      clientSecret,
      tags: [env["TAILSCALE_TAG"] ?? "tag:paseo-sandbox"],
    });
  }
  if (!mintTailnetKey) return null;

  return createRemoteSandboxProvisioner({
    host: createDaytonaHost({ apiKey: daytonaApiKey, apiUrl: env["DAYTONA_API_URL"] }),
    logger,
    image: env["PASEO_SANDBOX_IMAGE"] ?? "paseo-sandbox:0.4.0",
    mintTailnetKey,
  });
}

/**
 * Delegating session handler for the remote-sandbox RPCs. Mirrors the schedule
 * session: the daemon session dispatches to it and it emits outbound messages.
 * All logic stays here (fork-isolated); session.ts only routes.
 */
export class RemoteSandboxSession {
  private readonly provisioner: RemoteSandboxProvisioner | null;
  private readonly resolveOriginUrl: (cwd: string) => Promise<string>;

  constructor(private readonly deps: RemoteSandboxSessionDeps) {
    this.provisioner =
      deps.provisioner !== undefined ? deps.provisioner : buildEnvProvisioner(deps.logger);
    this.resolveOriginUrl = deps.resolveOriginUrl ?? resolveGitOriginUrl;
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
}
