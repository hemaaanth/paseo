import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

import type { SandboxHandle, SandboxHost, SandboxStatus } from "./sandbox-host.js";
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
// A backgrounded daemon intermittently keeps Daytona's exec stdout open, so
// executeCommand blocks waiting for EOF. Bound the launch short and never treat
// its return as the readiness signal — callers verify readiness separately.
const DETACH_START_TIMEOUT_S = 10;

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
  /**
   * Extra CORS origins for the in-box daemon. Unset in prod — the Electron app
   * connects with the `paseo://app` origin, which the daemon allows by default.
   * Set (e.g. `*`) only to let a browser web client on another port connect.
   */
  corsOrigins?: string;
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
  status(sandboxId: string): Promise<SandboxStatus>;
  resume(sandboxId: string): Promise<void>;
  check(): Promise<void>;
}

async function execOrThrow(box: SandboxHandle, command: string, what: string): Promise<string> {
  const res = await box.exec(command);
  if (res.exitCode !== 0) throw new Error(`${what} failed (exit ${res.exitCode}): ${res.output}`);
  return res.output;
}

/**
 * Launch a backgrounded daemon. The exec may hang on the child's held stdout, so
 * bound it and swallow that — readiness is the caller's job, not the exit code.
 */
async function startDetached(box: SandboxHandle, command: string): Promise<void> {
  await box.exec(command, DETACH_START_TIMEOUT_S).catch(() => {});
}

/** Poll until tailscaled's socket is up and the process is alive (or give up). */
async function waitTailscaled(box: SandboxHandle): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await box
      .exec(
        `test -S ${TS_SOCK} && pgrep -x tailscaled >/dev/null && echo READY || (sleep 1; echo NO)`,
        15,
      )
      .catch(() => null);
    if (res?.output.includes("READY")) return;
  }
  throw new Error("tailscaled did not become ready");
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

/**
 * Kick off the repo's pinned toolchain install (mise/devbox) in the background.
 * The snapshot already ships global toolchains on PATH, so provisioning must not
 * block ~a minute on this — repo-pinned versions land shortly after connect.
 * ponytail: fire-and-forget; if a repo needs its exact pin before the agent runs,
 * add a "wait for toolchain" gate then.
 */
async function resolveRepoEnv(box: SandboxHandle, logger: SeedLogger): Promise<void> {
  const inner =
    `cd ${REPO_DIR} && ` +
    `if [ -f mise.toml ] || [ -f .mise.toml ] || [ -f .tool-versions ]; then ` +
    `runuser -u paseo -- env HOME=${SANDBOX_HOME} PATH=/home/paseo/.local/bin:/usr/local/bin:/usr/bin:/bin ` +
    `sh -c 'mise trust && mise install -y'; ` +
    `elif [ -f devbox.json ]; then runuser -u paseo -- env HOME=${SANDBOX_HOME} devbox install; fi`;
  const res = await box.exec(
    `setsid nohup sh -c ${shellQuote(inner)} >/var/log/toolchain-install.log 2>&1 </dev/null & echo started`,
  );
  if (res.exitCode !== 0)
    logger.info({ output: res.output.trim() }, "resolveRepoEnv background launch failed");
}

/** Join the tailnet in userspace mode and expose the daemon port over it. */
async function joinTailnet(
  box: SandboxHandle,
  options: { authKey: string; hostname: string },
): Promise<{ tailnetIp: string; magicDns: string }> {
  await startDetached(
    box,
    `mkdir -p /var/lib/tailscale /var/run/tailscale && ` +
      `setsid nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=${TS_SOCK} ` +
      `--tun=userspace-networking --statedir=/var/lib/tailscale >/var/log/tailscaled.log 2>&1 </dev/null &`,
  );
  await waitTailscaled(box);
  // `tailscale up` occasionally hangs or half-authenticates on the first try
  // (leaves the node "Logged out"). Bound each attempt (90s) and retry once so a
  // stuck attempt fails fast instead of wedging the provision; `up` is idempotent.
  const upCmd =
    `${TS} up --authkey=${shellQuote(options.authKey)} --hostname=${shellQuote(options.hostname)} ` +
    `--accept-routes --timeout=60s`;
  let joined = false;
  for (let attempt = 1; attempt <= 2 && !joined; attempt++) {
    try {
      const res = await box.exec(upCmd, 90);
      if (res.exitCode === 0) joined = true;
      else if (attempt === 2)
        throw new Error(`tailscale up failed (exit ${res.exitCode}): ${res.output}`);
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  await execOrThrow(
    box,
    `${TS} serve --bg --tcp ${PORT} tcp://127.0.0.1:${PORT}`,
    "tailscale serve",
  );
  const tailnetIp = (await execOrThrow(box, `${TS} ip -4 | head -1`, "tailscale ip")).trim();
  if (!tailnetIp) throw new Error("tailscale reported no IPv4 after join");
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
async function startDaemon(
  box: SandboxHandle,
  hostAllow: string,
  corsOrigins?: string,
): Promise<void> {
  const corsEnv = corsOrigins ? `PASEO_CORS_ORIGINS=${shellQuote(corsOrigins)} ` : "";
  await startDetached(
    box,
    `runuser -u paseo -- bash -c ${shellQuote(
      `PASEO_HOSTNAMES=${hostAllow} ${corsEnv}setsid nohup paseo daemon start ` +
        `>${SANDBOX_HOME}/.paseo/daemon.log 2>&1 </dev/null &`,
    )}`,
  );
  const wait = await box.exec(
    `for i in $(seq 1 60); do ` +
      `c=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:${PORT}/ 2>/dev/null); ` +
      `[ "$c" != 000 ] && exit 0; sleep 1; done; exit 1`,
    90,
  );
  if (wait.exitCode !== 0) throw new Error("daemon did not start listening within 60s");
}

/** Start dockerd for repos that build container images (best-effort, detached). */
async function startDockerd(box: SandboxHandle): Promise<void> {
  await startDetached(
    box,
    `command -v dockerd >/dev/null && setsid nohup dockerd >/var/log/dockerd.log 2>&1 </dev/null &`,
  );
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
        await startDockerd(box);

        report("Joining tailnet");
        const authKey = await deps.mintTailnetKey();
        const { tailnetIp, magicDns } = await joinTailnet(box, {
          authKey,
          hostname: `paseo-${box.id.slice(0, 8)}`,
        });
        report("Starting daemon");
        await startDaemon(box, `${tailnetIp},${magicDns}`, deps.corsOrigins);

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

    status: (sandboxId: string): Promise<SandboxStatus> => deps.host.status(sandboxId),

    resume: (sandboxId: string): Promise<void> => deps.host.resume(sandboxId),

    check: (): Promise<void> => deps.host.check(),
  };
}
