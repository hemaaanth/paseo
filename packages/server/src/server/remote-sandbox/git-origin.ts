import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Normalize a git remote URL to an https clone URL so the sandbox can clone it
 * with the seeded `gh` token. SSH/scp remotes don't work with token auth.
 */
export function normalizeToHttps(url: string): string {
  const trimmed = url.trim();
  // scp form: git@github.com:owner/repo(.git)
  const scp = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  // ssh form: ssh://git@github.com/owner/repo(.git)
  const ssh = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return trimmed; // already http(s)
}

/**
 * Resolve the GitHub clone URL for a local checkout from its origin remote.
 * Runs on the daemon host (which has the repo), so the app only needs to pass
 * the project cwd.
 */
export async function resolveGitOriginUrl(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"]);
  const raw = stdout.trim();
  if (!raw) throw new Error(`no git origin configured for ${cwd}`);
  return normalizeToHttps(raw);
}
