import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SandboxHandle } from "./sandbox-host.js";

/** Image HOME; the agent CLIs read ~/.claude, ~/.codex, ~/.config here. */
export const SANDBOX_HOME = "/home/paseo";

/** uid/gid of the non-root `paseo` user the daemon and agents run as. */
const PASEO_UID = 1000;

/** Wrap a value as a single shell argument. Safe for base64/JSON/paths. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SeedEntry {
  label: string;
  /** Path relative to the daemon user's home, e.g. ".config/gh". */
  home: string;
  /** Absolute destination in the box. */
  remote: string;
}

/**
 * v1 seeding manifest: agent OAuth + the auth'd tool CLIs whose binaries the
 * sandbox image ships. Binaries live in the image; only the creds are copied.
 * See docs/remote-workspace-plan.md "Seeding manifest".
 */
export const DEFAULT_SEED_MANIFEST: SeedEntry[] = [
  {
    label: "Claude OAuth",
    home: ".claude/.credentials.json",
    remote: `${SANDBOX_HOME}/.claude/.credentials.json`,
  },
  { label: "Codex OAuth", home: ".codex/auth.json", remote: `${SANDBOX_HOME}/.codex/auth.json` },
  { label: "GitHub CLI", home: ".config/gh", remote: `${SANDBOX_HOME}/.config/gh` },
  {
    label: "Railway CLI",
    home: ".railway/config.json",
    remote: `${SANDBOX_HOME}/.railway/config.json`,
  },
  {
    label: "PostHog CLI",
    home: ".config/posthog-cli",
    remote: `${SANDBOX_HOME}/.config/posthog-cli`,
  },
  { label: "Linear CLI", home: ".config/linear-cli", remote: `${SANDBOX_HOME}/.config/linear-cli` },
];

interface CollectedFile {
  remote: string;
  data: Buffer;
}

/** Flatten a local file or directory into (remote path, bytes) pairs. */
function collectFiles(localRoot: string, remoteRoot: string): CollectedFile[] {
  const stat = statSync(localRoot);
  if (stat.isFile()) return [{ remote: remoteRoot, data: readFileSync(localRoot) }];
  if (!stat.isDirectory()) return [];
  const out: CollectedFile[] = [];
  for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
    const childLocal = join(localRoot, entry.name);
    const childRemote = `${remoteRoot}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectFiles(childLocal, childRemote));
    else if (entry.isFile()) out.push({ remote: childRemote, data: readFileSync(childLocal) });
  }
  return out;
}

/**
 * Copy a local file or directory into the box (base64 over exec, cross-platform —
 * no local `tar`), then hand the tree to the daemon uid so agents can read it and
 * refresh tokens in place. Returns false if the local path is absent.
 */
async function seedPath(
  box: SandboxHandle,
  localRoot: string,
  remoteRoot: string,
): Promise<boolean> {
  let files: CollectedFile[];
  try {
    files = collectFiles(localRoot, remoteRoot);
  } catch {
    return false; // absent locally
  }
  if (files.length === 0) return false;

  for (const file of files) {
    const dir = file.remote.replace(/\/[^/]+$/, "");
    const b64 = file.data.toString("base64");
    const res = await box.exec(
      `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(file.remote)}`,
    );
    if (res.exitCode !== 0) throw new Error(`seeding ${file.remote} failed: ${res.output}`);
  }
  const own = await box.exec(
    `chown -R ${PASEO_UID}:${PASEO_UID} ${shellQuote(remoteRoot)} && chmod -R u=rwX,go= ${shellQuote(remoteRoot)}`,
  );
  if (own.exitCode !== 0) throw new Error(`chown ${remoteRoot} failed: ${own.output}`);
  return true;
}

export interface SeedLogger {
  info(obj: unknown, msg?: string): void;
}

export interface SeedCredentialsOptions {
  homeDir: string;
  manifest?: SeedEntry[];
  logger?: SeedLogger;
}

/**
 * Copy the manifest's credential files/dirs from the daemon host into the box.
 * Returns the labels that were present and seeded (e.g. to decide `gh auth
 * setup-git`).
 */
export async function seedCredentials(
  box: SandboxHandle,
  options: SeedCredentialsOptions,
): Promise<string[]> {
  const manifest = options.manifest ?? DEFAULT_SEED_MANIFEST;
  const seeded: string[] = [];
  for (const entry of manifest) {
    const local = join(options.homeDir, entry.home);
    if (await seedPath(box, local, entry.remote)) {
      seeded.push(entry.label);
      options.logger?.info({ label: entry.label, remote: entry.remote }, "seeded credential");
    } else {
      options.logger?.info({ label: entry.label, local }, "credential absent, skipped");
    }
  }
  return seeded;
}

interface McpServerConfig {
  url?: string;
  type?: string;
  command?: string;
}

/**
 * Copy the portable (remote-URL) Claude MCP servers from the daemon host's
 * ~/.claude.json into the box via `claude mcp add-json`. Local-binary stdio
 * servers are skipped — they point at host paths absent in the box (see spike
 * doc §MCP). Account-linked claude.ai connectors need nothing here; they ride
 * the seeded OAuth.
 */
export async function seedClaudeMcp(
  box: SandboxHandle,
  options: { homeDir: string; logger?: SeedLogger },
): Promise<string[]> {
  let servers: Record<string, McpServerConfig>;
  try {
    const raw = readFileSync(join(options.homeDir, ".claude.json"), "utf8");
    servers = (JSON.parse(raw).mcpServers ?? {}) as Record<string, McpServerConfig>;
  } catch {
    return []; // no local Claude MCP config
  }
  const runAsPaseo =
    `runuser -u paseo -- env CLAUDE_CONFIG_DIR=${SANDBOX_HOME}/.claude ` +
    `HOME=${SANDBOX_HOME} PATH=/usr/local/bin:/usr/bin:/bin`;
  const seeded: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const isRemote = Boolean(cfg.url) || cfg.type === "http" || cfg.type === "sse";
    if (!isRemote) {
      options.logger?.info({ name, command: cfg.command }, "MCP not portable, skipped");
      continue;
    }
    const res = await box.exec(
      `${runAsPaseo} claude mcp add-json ${name} ${shellQuote(JSON.stringify(cfg))} -s user`,
    );
    if (res.exitCode === 0) {
      seeded.push(name);
      options.logger?.info({ name }, "seeded remote MCP");
    } else {
      options.logger?.info({ name, output: res.output.trim() }, "MCP add failed");
    }
  }
  return seeded;
}
