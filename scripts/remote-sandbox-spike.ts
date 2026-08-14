/**
 * Remote-sandbox spike — boot the Paseo daemon inside a disposable Daytona
 * sandbox, seed the user's native OAuth (Claude Code / Codex), clone a repo,
 * and drive an agent with the real `@getpaseo/client` SDK over the sandbox's
 * preview URL.
 *
 * This is a throwaway spike. Its job is to prove the things that can kill "run
 * agents in a remote sandbox":
 *   1. the published daemon image boots under Daytona and the daemon listens;
 *   2. `git clone` into the sandbox works as a boot step;
 *   3. the user's native OAuth, copied in, authenticates the agent CLIs;
 *   4. the SDK (== the app's own transport) connects over the preview URL.
 *
 * The `SandboxHost` interface is the one durable artifact — keep it host-neutral
 * so e2b/etc. are a second `implements`. Everything else here is expendable.
 *
 * SECURITY: seeding OAuth copies live tokens into a third-party sandbox. That is
 * a deliberate Tier-2 choice (see docs/remote-sandbox-spike.md). Ephemeral boxes
 * and auto-delete limit exposure; log out / rotate if the box is compromised.
 *
 * Run (fresh box, keep it alive to reuse):
 *   DAYTONA_API_KEY=... SPIKE_KEEP=1 \
 *   npx tsx scripts/remote-sandbox-spike.ts https://github.com/octocat/Hello-World.git
 *
 * Reuse that box for a turn once you know a valid provider string:
 *   DAYTONA_API_KEY=... SPIKE_SANDBOX_ID=<id> SPIKE_PROVIDER=codex/gpt-5.5 \
 *   npx tsx scripts/remote-sandbox-spike.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Daytona, Image } from "@daytona/sdk";
import { createPaseoClient } from "@getpaseo/client";

// ---- the durable seam ------------------------------------------------------

interface SandboxImage {
  base: string;
  setup: string[];
}

interface CreateSandboxOptions {
  image: SandboxImage;
  env: Record<string, string>;
  public?: boolean;
  autoStopMinutes?: number;
  autoDeleteMinutes?: number;
}

interface SandboxHandle {
  id: string;
  exec(command: string): Promise<{ exitCode: number; output: string }>;
  /** HTTPS base URL for a port exposed inside the sandbox. */
  previewUrl(port: number): Promise<string>;
  destroy(): Promise<void>;
}

interface SandboxHost {
  create(opts: CreateSandboxOptions): Promise<SandboxHandle>;
  attach(id: string): Promise<SandboxHandle>;
}

// ---- Daytona implementation ------------------------------------------------

class DaytonaHost implements SandboxHost {
  // Reads DAYTONA_API_KEY from the environment.
  private readonly daytona = new Daytona();

  async create(opts: CreateSandboxOptions): Promise<SandboxHandle> {
    let image = Image.base(opts.image.base);
    if (opts.image.setup.length > 0) image = image.runCommands(...opts.image.setup);

    const sandbox = await this.daytona.create({
      image,
      envVars: opts.env,
      public: opts.public ?? false,
      autoStopInterval: opts.autoStopMinutes ?? 15,
      autoDeleteInterval: opts.autoDeleteMinutes ?? 60,
      resources: { cpu: 2, memory: 4, disk: 8 },
    });
    return this.wrap(sandbox);
  }

  async attach(id: string): Promise<SandboxHandle> {
    return this.wrap(await this.daytona.get(id));
  }

  private wrap(sandbox: Awaited<ReturnType<Daytona["create"]>>): SandboxHandle {
    return {
      id: sandbox.id,
      exec: async (command) => {
        const res = await sandbox.process.executeCommand(command);
        return { exitCode: res.exitCode, output: res.result };
      },
      previewUrl: async (port) => (await sandbox.getPreviewLink(port)).url,
      destroy: async () => {
        await sandbox.delete();
      },
    };
  }
}

// ---- the spike ------------------------------------------------------------

const PORT = 6767;
const SANDBOX_HOME = "/home/paseo"; // image HOME; agent CLIs read ~/.claude, ~/.codex here
const REPO_DIR = "/workspace/repo"; // clone target; a subdir so we never rm the /workspace mountpoint

// Local OAuth files → where the sandbox's agent CLIs expect them.
const OAUTH_FILES: { local: string; remote: string }[] = [
  {
    local: join(homedir(), ".claude/.credentials.json"),
    remote: `${SANDBOX_HOME}/.claude/.credentials.json`,
  },
  { local: join(homedir(), ".codex/auth.json"), remote: `${SANDBOX_HOME}/.codex/auth.json` },
];

async function main(): Promise<void> {
  const password = randomBytes(18).toString("base64url");
  const provider = process.env.SPIKE_PROVIDER; // resolve after introspection if unset
  const prompt =
    process.env.SPIKE_PROMPT ??
    "List the top-level files and describe what this project does in one sentence.";
  const host = new DaytonaHost();

  const reuseId = process.env.SPIKE_SANDBOX_ID;
  const box = reuseId ? await host.attach(reuseId) : await provision(host, password);
  console.log(`[spike] sandbox: ${box.id}${reuseId ? " (reused)" : ""}`);

  try {
    const httpBase = await box.previewUrl(PORT);
    const previewHost = new URL(httpBase).host;
    // Daytona replaces the image entrypoint with its own init (PID 1 is
    // `daytona sleep infinity`), so the daemon never autostarts. Start it
    // ourselves, allowlisting the exact preview host for the host-header check.
    await ensureDaemon(box, previewHost);

    const wsUrl = `${toWs(httpBase)}/ws`;
    console.log(`[spike] connecting SDK: ${wsUrl}`);
    const client = createPaseoClient({
      url: wsUrl,
      password: reuseId ? requirePassword() : password,
    });
    await client.connect();

    // Introspect: which providers authenticated (proves OAuth seeding), and the
    // exact provider/model strings to use for a turn.
    await logProviders(client);

    if (provider) {
      console.log(`[spike] running turn with provider ${provider}…`);
      const agent = await client.agents.create({ config: { provider }, cwd: REPO_DIR, prompt });
      console.log(`[spike] agent ${agent.id} running…`);
      const result = await agent.waitForFinish();
      console.log(`\n=== agent result ===\n${result.lastMessage ?? "(no message)"}\n`);
    } else {
      console.log(
        `[spike] SPIKE_PROVIDER unset — skipping the turn. Re-run with a provider ` +
          `string from the list above and SPIKE_SANDBOX_ID=${box.id} to reuse this box.`,
      );
    }

    await client.close();
  } finally {
    if (process.env.SPIKE_KEEP || reuseId) {
      const httpBase = await box.previewUrl(PORT);
      console.log(
        `\n[spike] sandbox left running:\n` +
          `  id:       ${box.id}\n` +
          `  WSS:      ${toWs(httpBase)}/ws\n` +
          (reuseId ? "" : `  password: ${password}\n`) +
          `  delete from the Daytona dashboard when done.`,
      );
    } else {
      await box.destroy();
      console.log(`[spike] sandbox ${box.id} destroyed`);
    }
  }
}

async function provision(host: SandboxHost, password: string): Promise<SandboxHandle> {
  const repo = process.argv[2] ?? process.env.SPIKE_REPO;
  if (!repo) fail("usage: npx tsx scripts/remote-sandbox-spike.ts <git-repo-url>");

  const env: Record<string, string> = {
    PASEO_PASSWORD: password,
    PASEO_LISTEN: `0.0.0.0:${PORT}`,
    // PASEO_HOSTNAMES is set when we start the daemon (below), to the exact
    // preview host — we only learn it after the sandbox exists.
  };

  const box = await host.create({
    image: {
      base: "ghcr.io/getpaseo/paseo:latest",
      setup: [
        "npm install -g @anthropic-ai/claude-code @openai/codex",
        // gh CLI, for private clone / push / `gh pr create`
        "curl -fsSL https://github.com/cli/cli/releases/download/v2.97.0/gh_2.97.0_linux_amd64.tar.gz | " +
          "tar -xz -C /tmp && install /tmp/gh_2.97.0_linux_amd64/bin/gh /usr/local/bin/gh && " +
          "rm -rf /tmp/gh_2.97.0_linux_amd64",
      ],
    },
    env,
    // ponytail: public preview → the only auth left is PASEO_PASSWORD, so the
    // SDK connects with just `password` and no custom WS factory. Real version:
    // signed preview URL + x-daytona-preview-token header instead.
    public: true,
    autoStopMinutes: 15,
    autoDeleteMinutes: 60,
  });
  console.log(`[spike] sandbox created: ${box.id}`);

  // Seed the user's native OAuth so the agent CLIs are authenticated as them.
  // This alone brings all account-linked claude.ai MCP connectors, authenticated.
  await seedOAuth(box);
  // Seed GitHub CLI auth so agents can clone private repos, push, and open PRs.
  await seedGitHub(box);
  // Copy the portable (remote-URL) MCP definitions; local-binary stdio servers
  // can't run in a fresh box and are skipped with a note.
  await seedClaudeMcp(box);

  console.log(`[spike] cloning ${repo} → ${REPO_DIR}`);
  const clone = await box.exec(
    `mkdir -p /workspace && cd / && rm -rf ${REPO_DIR} && ` +
      `git clone --depth 1 ${shellQuote(repo)} ${REPO_DIR} && chown -R 1000:1000 ${REPO_DIR}`,
  );
  if (clone.exitCode !== 0) throw new Error(`git clone failed:\n${clone.output}`);

  return box;
}

// Copy one local file into the box via base64, owned by the daemon's uid (1000)
// so the agent CLIs can read (and refresh) it. Returns false if the local file
// is absent. Writing the whole parent dir to uid 1000 lets tools rewrite siblings.
async function seedFile(box: SandboxHandle, local: string, remote: string): Promise<boolean> {
  let contents: Buffer;
  try {
    contents = readFileSync(local);
  } catch {
    return false;
  }
  const dir = remote.replace(/\/[^/]+$/, "");
  const b64 = contents.toString("base64");
  const res = await box.exec(
    `mkdir -p ${dir} && printf %s ${shellQuote(b64)} | base64 -d > ${remote} && ` +
      `chown -R 1000:1000 ${dir} && chmod 600 ${remote}`,
  );
  if (res.exitCode !== 0) throw new Error(`seeding ${remote} failed:\n${res.output}`);
  return true;
}

async function seedOAuth(box: SandboxHandle): Promise<void> {
  for (const { local, remote } of OAUTH_FILES) {
    if (await seedFile(box, local, remote)) console.log(`[spike] seeded ${remote}`);
    else console.log(`[spike] no local ${local} — skipping`);
  }
}

// Seed GitHub CLI auth and point git's https helper at it, so private clone /
// push / `gh pr create` work. Same primitive as seedOAuth: copy creds, install
// binary (in the image setup). This is the CLI-auth pattern that also fits
// railway, posthog-cli, linear-cli, etc. — see docs/remote-sandbox-spike.md.
async function seedGitHub(box: SandboxHandle): Promise<void> {
  let seeded = false;
  for (const name of ["hosts.yml", "config.yml"]) {
    if (
      await seedFile(box, join(homedir(), ".config/gh", name), `${SANDBOX_HOME}/.config/gh/${name}`)
    ) {
      console.log(`[spike] seeded gh ${name}`);
      seeded = true;
    }
  }
  if (!seeded) {
    console.log("[spike] no local gh auth — skipping");
    return;
  }
  const res = await box.exec(
    `runuser -u paseo -- env HOME=${SANDBOX_HOME} PATH=/usr/local/bin:/usr/bin:/bin gh auth setup-git`,
  );
  console.log(`[spike] gh auth setup-git: ${res.exitCode === 0 ? "ok" : res.output.trim()}`);
}

// Copy the user's global Claude MCP servers into the sandbox — but only the
// portable ones. Remote (http/sse) servers connect anywhere; local-binary stdio
// servers point at host paths that don't exist in the box, so they're skipped.
// (Account-linked claude.ai connectors need nothing here — they ride the OAuth.)
async function seedClaudeMcp(box: SandboxHandle): Promise<void> {
  let servers: Record<string, { url?: string; type?: string; command?: string }>;
  try {
    const claudeJson = readFileSync(join(homedir(), ".claude.json"), "utf8");
    servers = JSON.parse(claudeJson).mcpServers ?? {};
  } catch {
    return; // no local Claude MCP config
  }
  const runAsPaseo =
    `runuser -u paseo -- env CLAUDE_CONFIG_DIR=${SANDBOX_HOME}/.claude ` +
    `HOME=${SANDBOX_HOME} PATH=/usr/local/bin:/usr/bin:/bin`;
  for (const [name, cfg] of Object.entries(servers)) {
    const isRemote = Boolean(cfg.url) || cfg.type === "http" || cfg.type === "sse";
    if (!isRemote) {
      console.log(`[spike] MCP '${name}' not portable (local stdio: ${cfg.command}) — skipped`);
      continue;
    }
    const res = await box.exec(
      `${runAsPaseo} claude mcp add-json ${name} ${shellQuote(JSON.stringify(cfg))} -s user`,
    );
    if (res.exitCode !== 0) {
      console.log(`[spike] MCP '${name}' add failed: ${res.output.trim()}`);
      continue;
    }
    console.log(`[spike] seeded remote MCP '${name}'`);
  }
}

async function logProviders(
  client: Awaited<ReturnType<typeof createPaseoClient>> | ReturnType<typeof createPaseoClient>,
): Promise<void> {
  try {
    // listAvailable proves the seeded OAuth authenticated each harness. (We skip
    // listModels — the turn's provider string is supplied via SPIKE_PROVIDER.)
    const available = await client.providers.listAvailable();
    console.log(`[spike] providers available:\n${JSON.stringify(available, null, 2)}`);
  } catch (err) {
    console.warn(`[spike] providers.listAvailable failed: ${String(err)}`);
  }
}

function requirePassword(): string {
  const pw = process.env.SPIKE_PASSWORD;
  if (!pw) fail("SPIKE_SANDBOX_ID set — also pass SPIKE_PASSWORD from the original run.");
  return pw;
}

function toWs(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws").replace(/\/$/, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function ensureDaemon(box: SandboxHandle, hostAllow: string): Promise<void> {
  // Probe from inside the box — the Daytona proxy answers even with nothing
  // behind it, so an external fetch can't tell "daemon up" from "proxy 502".
  const probe = await box.exec(
    `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:${PORT}/ 2>/dev/null || echo 000`,
  );
  if (probe.output.trim() !== "" && !probe.output.includes("000")) {
    console.log("[spike] daemon already listening");
    return;
  }

  console.log("[spike] starting daemon (as paseo user)…");
  // runuser preserves PASEO_PASSWORD / PASEO_LISTEN from the container env and
  // resets HOME to /home/paseo; we only override the host allowlist. setsid +
  // nohup detach it from this exec session so it keeps running.
  const start = await box.exec(
    `runuser -u paseo -- bash -c ${shellQuote(
      `PASEO_HOSTNAMES=${hostAllow} setsid nohup paseo daemon start ` +
        `>${SANDBOX_HOME}/.paseo/daemon.log 2>&1 </dev/null & echo started`,
    )}`,
  );
  if (start.exitCode !== 0) throw new Error(`daemon start failed:\n${start.output}`);

  const wait = await box.exec(
    `for i in $(seq 1 60); do ` +
      `c=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:${PORT}/ 2>/dev/null); ` +
      `[ "$c" != 000 ] && echo "up:$c" && exit 0; sleep 1; done; ` +
      `echo down; tail -n 20 ${SANDBOX_HOME}/.paseo/daemon.log; exit 1`,
  );
  if (wait.exitCode !== 0) throw new Error(`daemon did not listen on ${PORT}:\n${wait.output}`);
  console.log(`[spike] daemon ${wait.output.trim()}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
