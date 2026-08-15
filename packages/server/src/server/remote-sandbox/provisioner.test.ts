import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRemoteSandboxProvisioner } from "./provisioner.js";
import type { SandboxExecResult, SandboxHandle, SandboxHost } from "./sandbox-host.js";

const noopLogger = { info: () => {} };

interface FakeHost {
  host: SandboxHost;
  commands: string[];
  destroyed: string[];
}

/** A host whose exec records every command and returns canned tailscale output. */
function makeFakeHost(execImpl?: (command: string) => SandboxExecResult): FakeHost {
  const commands: string[] = [];
  const destroyed: string[] = [];
  const exec = async (command: string): Promise<SandboxExecResult> => {
    commands.push(command);
    if (execImpl) {
      const forced = execImpl(command);
      if (forced.exitCode !== 0) return forced;
    }
    if (command.includes("pgrep -x tailscaled")) return { exitCode: 0, output: "READY\n" };
    if (command.includes("ip -4")) return { exitCode: 0, output: "100.90.1.2\n" };
    if (command.includes("status --json"))
      return { exitCode: 0, output: "paseo-abc.tail1234.ts.net.\n" };
    return { exitCode: 0, output: "" };
  };
  const handle: SandboxHandle = {
    id: "box-1234abcd-ef",
    exec,
    previewUrl: async (port) => `https://${port}.example`,
  };
  const host: SandboxHost = {
    create: async () => handle,
    destroy: async (id) => {
      destroyed.push(id);
    },
    status: async () => "running",
    resume: async () => {},
    check: async () => {},
  };
  return { host, commands, destroyed };
}

describe("createRemoteSandboxProvisioner", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-provisioner-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/.credentials.json"), '{"claudeAiOauth":{"accessToken":"x"}}');
    mkdirSync(join(home, ".config/gh"), { recursive: true });
    writeFileSync(join(home, ".config/gh/hosts.yml"), "github.com:\n  oauth_token: x\n");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          context7: { type: "http", url: "https://mcp.context7.com/mcp" },
          local: { command: "/home/user/.local/bin/thing" },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("provisions a box: seeds creds, clones, joins tailnet, returns connection info", async () => {
    const fake = makeFakeHost();
    let minted = 0;
    const provisioner = createRemoteSandboxProvisioner({
      host: fake.host,
      logger: noopLogger,
      image: "paseo-sandbox:0.4.0",
      homeDir: home,
      mintTailnetKey: async () => {
        minted += 1;
        return "tskey-test";
      },
    });

    const result = await provisioner.provision({
      repoUrl: "https://github.com/acme/app.git",
      branch: "feature/x",
    });

    expect(result.sandboxId).toBe("box-1234abcd-ef");
    expect(result.tailnetIp).toBe("100.90.1.2");
    expect(result.magicDns).toBe("paseo-abc.tail1234.ts.net");
    expect(result.password).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(minted).toBe(1);

    const all = fake.commands.join("\n");
    // present local creds got seeded (base64 → the box paths)
    expect(all).toContain("/home/paseo/.claude/.credentials.json");
    expect(all).toContain("/home/paseo/.config/gh/hosts.yml");
    // codex OAuth was absent locally → never referenced
    expect(all).not.toContain("/home/paseo/.codex/auth.json");
    // gh git helper wired because GitHub creds were seeded
    expect(all).toContain("gh auth setup-git");
    // portable MCP added; local-binary one skipped
    expect(all).toContain("claude mcp add-json context7");
    expect(all).not.toContain("claude mcp add-json local");
    // clone used the requested branch + repo
    expect(all).toContain(
      "git clone --depth 1 --branch 'feature/x' 'https://github.com/acme/app.git'",
    );
    // tailnet joined and daemon started with the host allowlist
    expect(all).toContain("--authkey='tskey-test'");
    expect(all).toContain("serve --bg --tcp 6767");
    expect(all).toContain("PASEO_HOSTNAMES=100.90.1.2,paseo-abc.tail1234.ts.net");

    expect(fake.destroyed).toEqual([]);
  });

  test("tears down the box if provisioning fails (no leak)", async () => {
    const fake = makeFakeHost((command) =>
      command.includes("git clone") ? { exitCode: 1, output: "boom" } : { exitCode: 0, output: "" },
    );
    const provisioner = createRemoteSandboxProvisioner({
      host: fake.host,
      logger: noopLogger,
      image: "paseo-sandbox:0.4.0",
      homeDir: home,
      mintTailnetKey: async () => "tskey-test",
    });

    await expect(
      provisioner.provision({ repoUrl: "https://github.com/acme/app.git" }),
    ).rejects.toThrow(/git clone failed/);
    expect(fake.destroyed).toEqual(["box-1234abcd-ef"]);
  });

  test("teardown destroys the box by id", async () => {
    const fake = makeFakeHost();
    const provisioner = createRemoteSandboxProvisioner({
      host: fake.host,
      logger: noopLogger,
      image: "paseo-sandbox:0.4.0",
      homeDir: home,
      mintTailnetKey: async () => "tskey-test",
    });
    await provisioner.teardown("box-xyz");
    expect(fake.destroyed).toEqual(["box-xyz"]);
  });
});
