# Remote-sandbox spike

A throwaway spike that runs the whole Paseo daemon inside a disposable Daytona
sandbox, seeds the user's native OAuth, clones a repo into it, and drives an
agent with the real `@getpaseo/client` SDK over the sandbox's preview URL.

It exists to de-risk one idea: **"run agents in a remote sandbox" = boot the
existing daemon container somewhere disposable, then connect to it like any
remote host.** No daemon changes. The sandbox is just another host that happens
to be ephemeral.

Code: [`scripts/remote-sandbox-spike.ts`](../scripts/remote-sandbox-spike.ts).

## Validated end-to-end (2026-08-14)

A full run created a Daytona sandbox, seeded local Claude + Codex OAuth, cloned
a repo, started the daemon, connected the SDK, ran a Claude Code turn, and
destroyed the box — `SCRIPT_EXIT=0`. All four risks cleared:

1. **Boot.** `ghcr.io/getpaseo/paseo:latest` + agent CLIs builds and runs under
   Daytona. Caveat below: the daemon does **not** autostart.
2. **Code in.** `git clone` into `/workspace/repo` works.
3. **Auth.** Copying `~/.claude/.credentials.json` and `~/.codex/auth.json` into
   the sandbox home authenticates the native harnesses — `providers.listAvailable`
   returned `claude: available, codex: available`, and a `claude/sonnet` turn ran.
4. **Connect.** The SDK connects over the Daytona preview URL (`wss://6767-<id>.<proxy>/ws`);
   the proxy passes the WebSocket upgrade.

## Two things the run taught us

- **Daytona ignores the image entrypoint.** PID 1 is `daytona sleep infinity`, so
  the daemon never starts on its own. The script starts it explicitly as the
  `paseo` user (`runuser -u paseo -- … paseo daemon start`), which inherits
  `PASEO_PASSWORD`/`PASEO_LISTEN` from the container env.
- **Host-header check needs the exact preview host.** The proxy host is
  `6767-<id>.daytonaproxy01.net` (not a fixed domain), so the daemon is started
  with `PASEO_HOSTNAMES=<exact preview host>`, resolved from `getPreviewLink`
  after the box exists. An external HTTP probe can't tell "daemon up" from the
  proxy's own 502 page, so readiness is checked from **inside** the box.

## MCP and config replication (Tier 1)

There are four kinds of MCP server, and they replicate very differently. All
verified with `claude mcp list` inside the box.

1. **Account-linked claude.ai connectors — free with OAuth.** All 13 (Slack,
   Linear, Notion, HubSpot, Gmail, Drive, Calendar, Grain, Pylon, …) showed
   `✔ Connected` with only the OAuth credential seeded. They're bound to the
   Claude account, auth is server-side; nothing to copy. The interactive-OAuth
   MCPs are the _easy_ case, not the hard one.
2. **Plain public URL (e.g. `context7`, http) — copy the definition.** The spike
   does this with `claude mcp add-json`; no secret involved.
3. **OAuth/`mcp-remote` URL servers (posthog, slant, creed) — extract the bearer,
   register as direct http.** These wrap a remote URL in `mcp-remote`, whose
   OAuth lives in a local cache (`~/.mcp-auth/`, keyed `md5(fullURL)`), **not** in
   the definition. Seeding the cache is not enough: `mcp-remote` refuses to reuse
   cached tokens headlessly and re-opens a browser flow that can't complete.
   What works: read the cached `access_token` from
   `~/.mcp-auth/mcp-remote-*/<md5(url)>_tokens.json` and register the server as a
   **direct `http` MCP with `Authorization: Bearer <token>`**, skipping
   `mcp-remote` entirely. Verified — `posthog` connected `✔` this way. Caveats:
   the token expires (7 days here; a `refresh_token` is in the same file), it's a
   real secret in the box (Tier 2), and per-repo routing (posthog picks a project
   URL from `~/.config/agent-workspace/posthog.json`) must be resolved to a URL.
   Harness-agnostic: Codex/OMP take http+header too.
4. **Local-compute stdio (`codebase-memory`, `agentation`) — don't replicate.**
   They index the local checkout / talk to a local `127.0.0.1` service and belong
   on the local machine (or behind a Tier-3 proxy), not copied into a sandbox.

Net: connectors and public URLs are free/trivial; the OAuth `mcp-remote` servers
(the critical ones like posthog) work via the bearer-extraction recipe above,
which the spike documents but does not yet automate — the wrapper routing and
token refresh make it real feature work, not a copy step.

## Authenticated CLIs (the general pattern)

Most "replicate my env" needs reduce to one primitive we already use for OAuth:
**install the binary + copy its credential dir.** Agents shell out to the CLI,
which reads its own seeded auth. This is often simpler and more robust than MCP —
e.g. `posthog-cli` sidesteps the `mcp-remote` bearer dance entirely.

| CLI                         | Install (image `setup`)            | Copy                     |
| --------------------------- | ---------------------------------- | ------------------------ |
| `gh`                        | release tarball → `/usr/local/bin` | `~/.config/gh/`          |
| `railway`                   | its installer                      | `~/.railway/config.json` |
| `posthog-cli`               | its installer                      | `~/.config/posthog-cli/` |
| linear / dune / hubspot / … | each installer                     | each `~/.config/<tool>/` |

**GitHub is done and verified.** The spike installs `gh`, copies `~/.config/gh/`,
and runs `gh auth setup-git`. In-box checks: `gh auth status` → logged in with
`repo`+`workflow` scopes, `gh api user` authenticates, private repos list, and
git's https helper is `gh auth git-credential`. So private clone / push /
`gh pr create` all work — the full "private repo in, PR out" loop is plumbed.

The generalization (a declarative `{ install, copyPaths }` manifest folding gh,
railway, posthog-cli, OAuth, and MCP into one list) is the next feature, not yet
built — `seedFile` + `seedGitHub` are the shape it takes.

## Harness parity (Claude / Codex / OMP)

Seeding is harness-agnostic — OAuth and GitHub work for all three because they're
env/CLI-level. MCP and binary install differ per harness.

- **Claude Code** — fully working (OAuth, GitHub, MCP, turns). The reference.
- **Codex** — full parity, verified. OAuth (`~/.codex/auth.json`) → `codex: available`;
  GitHub via the shared `gh` seed; MCP via `[mcp_servers]` in `~/.codex/config.toml`
  (`codex mcp list` showed `context7`+`creed` enabled). Same portability rules as
  Claude; posthog maps to Codex's per-server "Bearer Token Env Var". Seed only the
  `[mcp_servers]` subset — the rest of `config.toml` (`[hooks.state]`, `[plugins]`,
  `[projects]`) is pinned to local paths and must not be copied.
- **OMP (oh-my-pi)** — the heavy harness; sandbox requirements all proven, but
  blocked on the published image. What works: the 188MB release binary
  (`omp-linux-x64`) downloads in-box via the seeded `gh` and runs; auth is
  env-based (`ANTHROPIC_OAUTH_TOKEN`, set from the seeded Claude OAuth — no
  auth-vault copy); MCP config is `~/.omp/agent/mcp.json` (same rules). **Blocker:**
  enabling the provider needs `agents.providers.omp.enabled: true` (confirmed from
  the user's own working config), but the published `ghcr.io/getpaseo/paseo:latest`
  (daemon `0.4.0`) still reports `omp` disabled with that exact config. The image
  predates the local daemon's OMP path — **version skew**. Fix is to build the
  sandbox image from the current source, not chase config. This also flags a real
  product constraint: the sandbox image version should track the daemon the user
  runs (see [protocol-compatibility.md](protocol-compatibility.md)).

## Private networking via Tailscale (spiked, works)

Instead of the public Daytona preview URL + password-over-the-internet, the box
can join the user's tailnet and be reached privately — effectively localhost over
WireGuard. Verified end-to-end:

- **Daytona containers run Tailscale in userspace mode** (`tailscaled
--tun=userspace-networking`, no TUN/`NET_ADMIN` needed). The box joined the
  tailnet, showed online, and saw every peer (desktop, laptop, phones).
- **Userspace mode does not auto-forward inbound** tailnet→localhost. Expose the
  daemon with `tailscale serve --bg --tcp 6767 tcp://127.0.0.1:6767`.
- **Reachable over the tailnet** from another node: `http://<tailnet-ip>:6767` →
  the daemon's real responses (web UI `200`, API `Unauthorized`). No public
  endpoint, no relay.
- **Host-header note:** connect by **tailnet IP** (IPs are allowed by default) or
  add the `*.ts.net` MagicDNS name to `PASEO_HOSTNAMES` — connecting by MagicDNS
  name returns `403` otherwise.
- **Productization:** auth keys are single-use (each box consumes one), so the
  provisioning daemon must **mint an ephemeral key per box** via the Tailscale
  API / an OAuth client, or use one reusable _tagged, ephemeral_ key. Ephemeral
  nodes auto-remove when the box stops — matches the ephemeral-box model.

This is the recommended v1 connection path: private, no world-reachable port, and
the app (on a tailnet device) connects to the box by tailnet IP like any host.

## Prerequisites

- A Daytona account and API key (`DAYTONA_API_KEY`).
- Local native-harness OAuth to seed: `~/.claude/.credentials.json` and/or
  `~/.codex/auth.json` (whatever exists is copied; the rest is skipped).
- `@getpaseo/client` built: `npm run build:client`.
- The Daytona SDK installed: `npm install` (`@daytona/sdk` is declared in the
  root `package.json`).

## Run

```bash
# Full run: seed OAuth, clone, start daemon, run a turn, destroy the box.
DAYTONA_API_KEY=... SPIKE_PROVIDER=claude/sonnet \
  npx tsx scripts/remote-sandbox-spike.ts https://github.com/octocat/Hello-World.git
```

Env knobs:

| Var                | Default                 | Meaning                                               |
| ------------------ | ----------------------- | ----------------------------------------------------- |
| `DAYTONA_API_KEY`  | —                       | Daytona auth (read by the SDK).                       |
| `SPIKE_PROVIDER`   | unset (skips the turn)  | `provider/model`, e.g. `claude/sonnet`, `codex/…`.    |
| `SPIKE_PROMPT`     | a one-line repo summary | What the agent is asked to do.                        |
| `SPIKE_KEEP`       | unset                   | Leave the box up and print its WSS URL + password.    |
| `SPIKE_SANDBOX_ID` | unset                   | Reuse an existing box (skips provisioning).           |
| `SPIKE_PASSWORD`   | —                       | Required with `SPIKE_SANDBOX_ID`; the box's password. |

With `SPIKE_KEEP=1` the script prints a `wss://…/ws` URL and password you can add
as a host in the app to prove the connection by hand. Delete the box from the
Daytona dashboard when done.

## Deliberate corners (tighten before this is real)

Marked `ponytail:` in the script. Each is a shortcut, not a design:

- **Public preview URL.** The box is created `public: true`, so the only auth on
  the connection is `PASEO_PASSWORD`. Real version: a _signed_ preview URL or the
  `x-daytona-preview-token` header, so the port isn't world-reachable.
- **OAuth copied into a third party (Tier 2).** Seeding `.credentials.json` /
  `auth.json` ships live tokens into Daytona. Deliberate and accepted here;
  ephemeral boxes + auto-delete limit exposure. The safer end-states are Tier 1
  (config only, secrets as scoped env) and Tier 3 (no creds in the box, auth
  proxied back to the local daemon).
- **`chown -R 1000:1000 /workspace/repo`.** The exec user is root; the daemon
  runs as `paseo` (uid 1000). The clone is handed to uid 1000 so agents can write.

## What comes after

The plumbing works, so the next decision is presentation, not plumbing: whether
each sandbox shows as its own host (naive, some churn) or the local daemon
brokers several sandbox daemons into one view. The SDK supports N independent
daemon connections from one process, so brokering is additive — it sits on top of
this plumbing, it doesn't replace it.
