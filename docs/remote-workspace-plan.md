# Remote workspaces — implementation plan

**Status:** mostly shipped on the `design/remote-sandbox-mvp` fork (not upstreamed). The spike ([remote-sandbox-spike.md](remote-sandbox-spike.md)) proved the groundwork; **Shipped** below is what's built, **Open decisions** is what's left. Fold the durable parts into [providers.md](providers.md) / [architecture.md](architecture.md) if this ever upstreams, then delete this file.

## Goal

A **"Remote" toggle** on the New Workspace screen. Checking it provisions a
disposable cloud sandbox (Daytona) that runs its own Paseo daemon, seeds the
user's auth, clones the repo+branch, joins the user's tailnet, and starts an
agent. The user talks to it **like any other workspace** — because to the app it
is one.

Scope for v1: one provider (Daytona), ephemeral per-task boxes, Tailscale
connection, unified presentation. Not in v1: MCP `mcp-remote` bearer automation,
OMP, cost/idle dashboards, second sandbox provider.

## Shipped

All under `packages/server/src/server/remote-sandbox/` (daemon) and the app files noted.

- **Provisioner** — `SandboxHost` interface (`sandbox-host.ts`) + Daytona adapter
  (`daytona-host.ts`); `provisioner.ts` seeds creds/MCP, clones, joins the tailnet,
  starts the in-box daemon. Snapshot boot (`snapshot:` ref), backgrounded toolchain
  install, detached daemon-start + readiness polling (Daytona exec hangs on a
  backgrounded process holding stdout), bounded exec timeouts, `tailscale up` retry.
- **RPCs** — `remote.sandbox.provision` (fast ack + progress stream), `.teardown`,
  `.status`/`.resume` (provider-neutral running/suspended/deleted), and
  `.config.get`/`.set`/`.test` (settings). Env vars remain a fallback for creds.
- **App** — `runtime/remote-sandbox.ts` provisions, connects the hidden host
  (`hidden` + `remoteSandbox` on the host profile — both persisted, see the wipe
  fix below), and kickstarts the first agent with the composer's picker settings
  (provider/model/mode/thinking/fast). Compact "Remote" toggle + fixed-height
  status on New Workspace; cloud icon on remote sidebar rows.
- **Lifecycle + teardown** — archiving a remote workspace destroys its box via the
  provisioner (`use-workspace-archive.ts`); `SandboxHost.status()/resume()` back the
  lifecycle states.
- **Settings** — `screens/settings/remote-sandbox-page.tsx` (Settings → host →
  Remote sandbox) on a write-only config store (`config-store.ts`): secrets stay on
  the daemon, clients only ever see "configured". "Test connection" probes creds.

Still open (see also Open decisions): warm-resume (start a suspended box →
re-bootstrap tailnet+daemon → reconnect), reconnect-on-startup for remote hosts,
a second provider, and mirrored history (read-only after a cloud delete).

**Registry-wipe fix (critical):** persisting `hidden`/`remoteSandbox` on the host
profile without adding them to the strict `StoredHostRegistrySchema` made the whole
registry fail validation and get deleted on reload — a remote session would vanish.
Any new persisted `HostProfile` field must be added to that schema.

## Why the unified UX is cheap (the key finding)

The app is **already cross-`serverId`**. The sidebar workspace list
(`use-sidebar-workspaces-list.ts:97`), aggregated agents
(`use-aggregated-agents.ts:22`), command center, and sessions screen all
aggregate across every connected host; workspaces are keyed
`${serverId}:${workspaceId}` (`projects/workspace-structure.ts:88`). So a sandbox
registered as a host shows its workspace in the normal unified list with **no new
aggregation code**. We only need to keep the sandbox host out of the _switcher_,
not out of the _lists_.

## Architecture

```
New Workspace ──"Remote" toggle──► app calls remote.sandbox.provision.request
                                          │  (to the daemon that advertises the capability)
                                          ▼
                          Provisioner (daemon module, = the spike)
                          • create Daytona box (SandboxHost interface)
                          • seed OAuth + gh + MCP (Tier-2)
                          • clone repo+branch, chown
                          • mint ephemeral tailnet key, join tailnet, `tailscale serve`
                          • start in-box daemon, enable providers
                          • return { tailnetIp, magicDns, password }
                                          │
                                          ▼
        app registers a HIDDEN host (serverId = sandbox daemon id) and
        creates the workspace+first agent against it via the EXISTING per-serverId path.
        Sidebar shows it unified with a "Remote" badge. App connects by tailnet IP.
```

Chosen model: **provision + register hidden host** (the app connects to the
sandbox daemon directly over the tailnet). The alternative — the local daemon
proxying the sandbox daemon's workspace through its own API — is a from-scratch
federation subsystem and is explicitly rejected (nothing in the daemon is a
client of another daemon today; see spike doc §federation).

## Phases

### Phase 0 — productionize the provisioner

Turn `scripts/remote-sandbox-spike.ts` into a daemon module. Keep the durable
seam: a host-neutral `SandboxHost` interface (`create / exec / previewUrl /
destroy`) with a `DaytonaHost` impl, so e2b/etc. are a second `implements`.

**Build the sandbox image once.** [`docker/Dockerfile.sandbox`](../docker/Dockerfile.sandbox)
is `paseo:0.4.0` + agent CLIs + the manifest tool CLIs + `mise` language
toolchains + Tailscale. Publish it (or snapshot in Daytona) and boot boxes from
it — do not install toolchains at provision time. The provisioner switches from
the spike's inline `setup` to booting this image.

Move the proven steps into named, testable units: `seedOAuth`, `seedGitHub`,
`seedToolCli` (railway/posthog/linear creds), `seedClaudeMcp`/`seedCodexMcp`,
`cloneRepo`, `resolveRepoEnv` (per repo markers: `mise trust && mise install`, or
`devbox install` on the devbox snapshot), `startDaemon`, `joinTailnet`.
The spike already covers boot, clone, OAuth, gh, Codex/Claude MCP, and the daemon
start/host-header handling — reuse that verbatim.

**Seeding manifest (v1).** Binaries live in the image; the provisioner copies the
creds:

| What         | Copy into box                 | Notes                               |
| ------------ | ----------------------------- | ----------------------------------- |
| Claude OAuth | `~/.claude/.credentials.json` | authenticates Claude Code           |
| Codex OAuth  | `~/.codex/auth.json`          | authenticates Codex                 |
| GitHub       | `~/.config/gh/`               | + `gh auth setup-git`               |
| Railway      | `~/.railway/config.json`      |                                     |
| PostHog CLI  | `~/.config/posthog-cli/`      | CLI path (not the `mcp-remote` MCP) |
| Linear CLI   | `~/.config/linear-cli/`       |                                     |

`seedFile` from the spike already does the copy+chown+chmod; each row is one entry.

**Snapshots & toolchains.** Two published snapshots, both `FROM paseo:0.4.0`:

- [`docker/Dockerfile.sandbox`](../docker/Dockerfile.sandbox) — **base**: agent
  CLIs, manifest tool CLIs, `mise` runtimes (single version each:
  node/pnpm/bun/uv/python/go/rust/just), `corepack`, Docker-in-Docker, Tailscale.
- [`docker/Dockerfile.sandbox-devbox`](../docker/Dockerfile.sandbox-devbox) —
  base + nix + `devbox`, for goldsky-style repos (`monorepo`, `website`, `cms`,
  `docs` all ship `devbox.json` + `flake.nix`).

The snapshot ref is a **provisioner parameter**; pick by repo (default base;
devbox-marked repos → devbox snapshot). At clone time the provisioner detects the
env manager and materializes it: `mise.toml`/`.tool-versions` → `mise trust &&
mise install`; `devbox.json` → `devbox install`. Pre-warming a specific repo's
env into a dedicated snapshot (e.g. the goldsky monorepo) is an optional later
speedup — it needs the repo cloned at image-build time.

### Phase 1 — daemon capability

1. **Feature flag.** Add `remoteSandbox` to `buildServerInfoStatusPayload`
   (`packages/server/src/server/websocket-server.ts:1531`), gated on whether the
   daemon is configured with sandbox creds (`this.advertiseRemoteSandbox`).
2. **RPCs** (dotted, per [rpc-namespacing.md](rpc-namespacing.md)):
   `remote.sandbox.provision.request/.response` and
   `remote.sandbox.teardown.request/.response`. Provision returns the sandbox
   daemon's connection info (`tailnetIp`, `magicDns`, `password`, `serverId`).
3. **Provisioning branch.** Hook the provisioner at
   `worktree-session.ts:587` (`createPaseoWorktreeWorkflow`) /
   `paseo-worktree-service.ts:64` — when the request is remote, skip the local
   worktree and run the Phase-0 provisioner.
4. **Workspace placement.** `initialWorkspacePlacement`
   (`workspace-registry-model.ts`) currently only knows `checkout` /
   `created_worktree` — add a `remote_sandbox` placement carrying the box id +
   connection info. This is the main schema ripple.
5. **Config.** Daemon holds: Daytona API key, a **Tailscale OAuth client**
   (client_id/secret), the sandbox image ref, and a default seeding manifest.
6. **Lifecycle.** Track provisioned boxes; teardown deletes the Daytona box (the
   ephemeral tailnet node auto-removes). Rely on Daytona `autoStop`/`autoDelete`
   as the backstop.

### Phase 2 — app

1. **Remote toggle** in the selector row (`useNewWorkspaceFormStack`,
   `new-workspace-screen.tsx:1448`), shown only when the active daemon advertises
   `remoteSandbox`. Remembered like the isolation preference.
2. **Branch on submit** at `ensureWorkspace` / `createMultiplicityWorkspace`
   (`new-workspace-screen.tsx:820`): call `remote.sandbox.provision`, register the
   returned box as a host via the existing `HostRuntimeStore` path
   (`host-runtime.ts:1500`-style `probeAndUpsertConnection`) using the tailnet IP,
   then create the workspace+first agent against that new `serverId` and navigate.
3. **Hidden-host flag.** Add `hidden` to `HostProfile`
   (`types/host-connection.ts:46`); filter it out in the host switcher/chooser
   (`hosts/host-chooser.tsx:76`, `sidebar/display-preferences/menu.tsx:138`) while
   leaving the aggregation hooks unfiltered.
4. **Label threshold.** Don't count hidden hosts in
   `shouldShowSidebarHostLabels` (`sidebar-workspaces-view-model.ts:469`) so normal
   workspaces don't sprout host badges; instead badge the remote workspace itself
   with a "Remote" indicator.
5. **Offline handling.** When the box stops, its connection drops → the workspace
   shows offline/archives. Acceptable for ephemeral.

### Phase 3 — later / optional

Teardown affordance in the UI, cost/idle surfacing, posthog/`mcp-remote` bearer
automation, OMP (blocked on image version), a second `SandboxHost` provider.

## Ephemeral Tailscale keys

The provisioning daemon mints one per box:

1. Hold a Tailscale **OAuth client** (admin console → Settings → OAuth clients,
   scope `auth_keys`).
2. `POST https://api.tailscale.com/api/v2/oauth/token` with client_id/secret →
   access token.
3. `POST /api/v2/tailnet/-/keys` with
   `capabilities.devices.create = { ephemeral: true, preauthorized: true,
reusable: false, tags: ["tag:paseo-sandbox"] }` → a fresh `tskey-auth-…`.
4. Pass to the box's `tailscale up --authkey=… --hostname=paseo-<id>`.

OAuth-minted keys must be tagged — use that: tag sandbox nodes `tag:paseo-sandbox`
and scope them in ACLs. Ephemeral nodes auto-remove when the box stops.

## Connection (from the spike)

Box joins the tailnet (userspace `tailscaled --tun=userspace-networking`),
`tailscale serve --bg --tcp 6767 tcp://127.0.0.1:6767` exposes the daemon. The app
connects **by tailnet IP** (IPs pass host-header validation by default) — or add
the `*.ts.net` name to `PASEO_HOSTNAMES`. No public preview, no relay.

## Open decisions

- **Image version — decided: `0.4.0`.** Base the sandbox image on
  `ghcr.io/getpaseo/paseo:0.4.0`. Re-pin when the user upgrades their daemon; the
  constraint "sandbox image version == daemon version" stays real
  (see [protocol-compatibility.md](protocol-compatibility.md)). OMP is out of
  scope for v1, so its version-skew blocker no longer applies here.
- **Seeding manifest — decided.** OAuth (Claude + Codex), gh, Railway, PostHog
  CLI, Linear CLI (see the Phase-0 table). Claude + Codex only; not OMP.
- **Dev toolchains — decided: `mise` + `devbox`, two snapshots.** Repos are
  pnpm-dominant Node with Rust/Go/Python mixed in and per-repo pins; goldsky repos
  use `devbox`/nix. See "Snapshots & toolchains" below.
- **Docker builds — supported.** Daytona sandboxes have a dedicated kernel and
  support Docker-in-Docker, so the base image bundles Docker and the repos that
  ship Dockerfiles can `docker build` in-box. `dockerd` starts at boot; needs
  ≥2 vCPU / 4 GiB (already allocated).
- **Who holds the creds — shipped.** Daytona key + Tailscale key live in a
  write-only daemon config (`config-store.ts`, `$PASEO_HOME/remote-sandbox-config.json`,
  0600). Clients set values but only ever read back "configured" booleans — secrets
  never leave the daemon. Env vars remain a fallback. Configured via the settings page.
- **Teardown policy — shipped.** Archiving a remote workspace destroys its box now
  (`use-workspace-archive.ts` → `remote.sandbox.teardown`). Daytona `autoStop`
  (15 min) / `autoDelete` (60 min) remain the backstop for boxes that aren't archived.

## Security

Seeding copies live tokens into a third-party box (Tier-2 — deliberate, per spike
doc). Mitigations: ephemeral boxes + auto-delete, `tag:paseo-sandbox` + ACL
scoping, tailnet-private connection (no public port). Provide a one-tap teardown
and document that revoking is per-credential.

## Testing

`scripts/remote-sandbox-spike.ts` is the integration harness — keep it working as
the end-to-end smoke test while the daemon module is extracted. Unit-test the
provisioner steps against a fake `SandboxHost`. Use the in-process daemon test
harness ([ad-hoc-daemon-testing.md](ad-hoc-daemon-testing.md)) for the RPC + the
`remote_sandbox` placement record.
