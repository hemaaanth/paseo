import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

import type { SandboxHandle, SandboxHost } from "./sandbox-host.js";
import {
  SANDBOX_HOME,
  seedClaudeMcp,
  seedCredentials,
  shellQuote,
  type SeedLogger,
} from "./seeding.js";

const PORT = 6767;
const REPO_DIR = "/workspace/repo";
const TS_SOCK = "/var/run/tailscale/tailscaled.sock";
const TS = `tailscale --socket=${TS_SOCK}`;

export interface ProvisionRequest {
  /** Git URL to clone (private repos work via the seeded gh credential). */
  repoUrl: string;
  /** Branch to check out / create. Defaults to the repo default. */
  branch?: string;
}

export interface ProvisionResult {
  sandboxId: string;
  /** Tailnet IPv4 — connect here (IPs pass the daemon host-header check). */
  tailnetIp: string;
  /** MagicDNS name, e.g. paseo-<id>.<tailnet>.ts.net. */
  magicDns: string;
  /** Generated daemon password. */
  password: string;
}

export interface RemoteSandboxProvisionerDeps {
  host: SandboxHost;
  logger: SeedLogger;
  /** Snapshot/image ref the box boots from (e.g. paseo-sandbox:0.4.0). */
  image: string;
  /** Mints a fresh ephemeral, tagged Tailscale auth key per box. */
  mintTailnetKey: () => Promise<string>;
  /** Daemon-host home dir to read seeded creds from. Defaults to os.homedir(). */
  homeDir?: string;
}

export interface ProvisionProgress {
  step: string;
  detail?: string;
}

export type ProvisionProgressListener = (progress: ProvisionProgress) => void;

export interface RemoteSandboxProvisioner {
  provision(
    request: ProvisionRequest,
    onProgress?: ProvisionProgressListener,
  ): Promise<ProvisionResult>;
  teardown(sandboxId: string): Promise<void>;
}

async function execOrThrow(box: SandboxHandle, command: string, what: string): Promise<string> {
  const res = await box.exec(command);
  if (res.exitCode !== 0) throw new Error(`${what} failed (exit ${res.exitCode}): ${res.output}`);
  return res.output;
}

/** Clone into a subdir so we never rm the /workspace mountpoint; hand it to uid 1000. */
async function cloneRepo(
  box: SandboxHandle,
  repoUrl: string,
  branch: string | undefined,
): Promise<void> {
  const branchFlag = branch ? `--branch ${shellQuote(branch)} ` : "";
  await execOrThrow(
    box,
    `mkdir -p /workspace && cd / && rm -rf ${REPO_DIR} && ` +
      `git clone --depth 1 ${branchFlag}${shellQuote(repoUrl)} ${REPO_DIR} && ` +
      `chown -R 1000:1000 ${REPO_DIR}`,
    "git clone",
  );
}

/** Best-effort: materialize the repo's pinned toolchain (mise or devbox). */
async function resolveRepoEnv(box: SandboxHandle, logger: SeedLogger): Promise<void> {
  const script =
    `cd ${REPO_DIR} && ` +
    `if [ -f mise.toml ] || [ -f .mise.toml ] || [ -f .tool-versions ]; then ` +
    `runuser -u paseo -- env HOME=${SANDBOX_HOME} PATH=/home/paseo/.local/bin:/usr/local/bin:/usr/bin:/bin ` +
    `sh -c 'mise trust && mise install -y'; ` +
    `elif [ -f devbox.json ]; then runuser -u paseo -- env HOME=${SANDBOX_HOME} devbox install; ` +
    `else echo 'no repo env manifest'; fi`;
  const res = await box.exec(script);
  if (res.exitCode !== 0)
    logger.info({ output: res.output.trim() }, "resolveRepoEnv non-fatal failure");
}

/** Join the tailnet in userspace mode and expose the daemon port over it. */
async function joinTailnet(
  box: SandboxHandle,
  options: { authKey: string; hostname: string },
): Promise<{ tailnetIp: string; magicDns: string }> {
  await execOrThrow(
    box,
    `mkdir -p /var/lib/tailscale /var/run/tailscale && ` +
      `setsid nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=${TS_SOCK} ` +
      `--tun=userspace-networking --statedir=/var/lib/tailscale >/var/log/tailscaled.log 2>&1 </dev/null & sleep 3`,
    "start tailscaled",
  );
  await execOrThrow(
    box,
    `${TS} up --authkey=${shellQuote(options.authKey)} --hostname=${shellQuote(options.hostname)} ` +
      `--accept-routes --timeout=70s`,
    "tailscale up",
  );
  await execOrThrow(
    box,
    `${TS} serve --bg --tcp ${PORT} tcp://127.0.0.1:${PORT}`,
    "tailscale serve",
  );
  const tailnetIp = (await execOrThrow(box, `${TS} ip -4 | head -1`, "tailscale ip")).trim();
  const magicDns = (
    await execOrThrow(box, `${TS} status --json | jq -r .Self.DNSName`, "tailscale magicdns")
  )
    .trim()
    .replace(/\.$/, "");
  return { tailnetIp, magicDns };
}

/**
 * Start the in-box daemon as the paseo user. `runuser` (no env reset) preserves
 * PASEO_PASSWORD / PASEO_LISTEN from the container env; we only add the host
 * allowlist. Daytona replaces the image entrypoint, so the daemon never
 * autostarts (spike doc §"Two things the run taught us").
 */
async function startDaemon(box: SandboxHandle, hostAllow: string): Promise<void> {
  await execOrThrow(
    box,
    `runuser -u paseo -- bash -c ${shellQuote(
      `PASEO_HOSTNAMES=${hostAllow} setsid nohup paseo daemon start ` +
        `>${SANDBOX_HOME}/.paseo/daemon.log 2>&1 </dev/null & echo started`,
    )}`,
    "daemon start",
  );
  const wait = await box.exec(
    `for i in $(seq 1 60); do ` +
      `c=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:${PORT}/ 2>/dev/null); ` +
      `[ "$c" != 000 ] && exit 0; sleep 1; done; exit 1`,
  );
  if (wait.exitCode !== 0) throw new Error("daemon did not start listening within 60s");
}

/** Start dockerd for repos that build container images (best-effort). */
async function startDockerd(box: SandboxHandle, logger: SeedLogger): Promise<void> {
  const res = await box.exec(
    `command -v dockerd >/dev/null && (setsid nohup dockerd >/var/log/dockerd.log 2>&1 </dev/null & sleep 2; echo started) || echo 'no dockerd'`,
  );
  if (res.exitCode !== 0)
    logger.info({ output: res.output.trim() }, "dockerd start non-fatal failure");
}

export function createRemoteSandboxProvisioner(
  deps: RemoteSandboxProvisionerDeps,
): RemoteSandboxProvisioner {
  const homeDir = deps.homeDir ?? homedir();

  return {
    provision: async (
      request: ProvisionRequest,
      onProgress?: ProvisionProgressListener,
    ): Promise<ProvisionResult> => {
      const report = (step: string, detail?: string): void => {
        deps.logger.info({ step, detail }, "provision progress");
        onProgress?.({ step, detail });
      };

      const password = randomBytes(18).toString("base64url");
      report("Creating sandbox");
      const box = await deps.host.create({
        image: deps.image,
        env: { PASEO_PASSWORD: password, PASEO_LISTEN: `0.0.0.0:${PORT}` },
      });

      try {
        report("Seeding credentials");
        const seeded = await seedCredentials(box, { homeDir, logger: deps.logger });
        if (seeded.includes("GitHub CLI")) {
          await box.exec(
            `runuser -u paseo -- env HOME=${SANDBOX_HOME} PATH=/usr/local/bin:/usr/bin:/bin gh auth setup-git`,
          );
        }
        report("Seeding MCP servers");
        await seedClaudeMcp(box, { homeDir, logger: deps.logger });
        report("Cloning repository", request.repoUrl);
        await cloneRepo(box, request.repoUrl, request.branch);
        report("Installing toolchain");
        await resolveRepoEnv(box, deps.logger);
        report("Starting Docker");
        await startDockerd(box, deps.logger);

        report("Joining tailnet");
        const authKey = await deps.mintTailnetKey();
        const { tailnetIp, magicDns } = await joinTailnet(box, {
          authKey,
          hostname: `paseo-${box.id.slice(0, 8)}`,
        });
        report("Starting daemon");
        await startDaemon(box, `${tailnetIp},${magicDns}`);

        report("Ready");
        return { sandboxId: box.id, tailnetIp, magicDns, password };
      } catch (error) {
        // Don't leak a half-provisioned box on failure.
        await deps.host.destroy(box.id).catch(() => {});
        throw error;
      }
    },

    teardown: async (sandboxId: string): Promise<void> => {
      await deps.host.destroy(sandboxId);
      deps.logger.info({ sandboxId }, "sandbox torn down");
    },
  };
}
