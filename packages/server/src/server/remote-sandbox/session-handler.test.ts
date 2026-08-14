import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import type { ProvisionRequest, RemoteSandboxProvisioner } from "./provisioner.js";
import { RemoteSandboxSession } from "./session-handler.js";

const noopLogger = { info: () => {}, error: () => {} };

interface Harness {
  emitted: SessionOutboundMessage[];
  terminal: Promise<void>;
}

function makeHarness(): Harness & { emit: (m: SessionOutboundMessage) => void } {
  const emitted: SessionOutboundMessage[] = [];
  let resolve: () => void = () => {};
  const terminal = new Promise<void>((r) => {
    resolve = r;
  });
  const emit = (m: SessionOutboundMessage): void => {
    emitted.push(m);
    if (
      m.type === "remote.sandbox.provision.progress" &&
      (m.payload.status === "completed" || m.payload.status === "failed")
    ) {
      resolve();
    }
  };
  return { emitted, terminal, emit };
}

const okProvisioner: RemoteSandboxProvisioner = {
  provision: async (_request: ProvisionRequest, onProgress) => {
    onProgress?.({ step: "Creating sandbox" });
    return {
      sandboxId: "s1",
      tailnetIp: "100.0.0.1",
      magicDns: "paseo-s1.tail.ts.net",
      password: "pw",
    };
  },
  teardown: async () => {},
  status: async () => "running",
  resume: async () => {},
};

describe("RemoteSandboxSession", () => {
  test("provision: acks fast, streams running progress, completes with connection", async () => {
    const h = makeHarness();
    const session = new RemoteSandboxSession({
      emit: h.emit,
      logger: noopLogger,
      resolveOriginUrl: async () => "https://github.com/acme/app.git",
      provisioner: okProvisioner,
    });
    await session.handleProvisionRequest({
      type: "remote.sandbox.provision.request",
      payload: { requestId: "r1", cwd: "/home/me/app" },
    });
    await h.terminal;

    const ack = h.emitted[0];
    expect(ack?.type).toBe("remote.sandbox.provision.response");
    if (ack?.type !== "remote.sandbox.provision.response") throw new Error("bad ack");
    expect(ack.payload.error).toBeNull();
    const provisionId = ack.payload.provisionId;

    const progress = h.emitted.filter((m) => m.type === "remote.sandbox.provision.progress");
    expect(
      progress.map((m) => m.type === "remote.sandbox.provision.progress" && m.payload.status),
    ).toEqual(["running", "completed"]);
    const done = progress.at(-1);
    if (done?.type !== "remote.sandbox.provision.progress") throw new Error("bad progress");
    expect(done.payload.provisionId).toBe(provisionId);
    expect(done.payload.connection).toEqual({
      sandboxId: "s1",
      tailnetIp: "100.0.0.1",
      magicDns: "paseo-s1.tail.ts.net",
      password: "pw",
    });
  });

  test("provision: emits failed progress when the provisioner throws", async () => {
    const h = makeHarness();
    const failing: RemoteSandboxProvisioner = {
      provision: async () => {
        throw new Error("daytona exploded");
      },
      teardown: async () => {},
      status: async () => "running",
      resume: async () => {},
    };
    const session = new RemoteSandboxSession({
      emit: h.emit,
      logger: noopLogger,
      resolveOriginUrl: async () => "https://github.com/acme/app.git",
      provisioner: failing,
    });
    await session.handleProvisionRequest({
      type: "remote.sandbox.provision.request",
      payload: { requestId: "r1", cwd: "/home/me/app" },
    });
    await h.terminal;

    const failed = h.emitted.at(-1);
    if (failed?.type !== "remote.sandbox.provision.progress") throw new Error("bad progress");
    expect(failed.payload.status).toBe("failed");
    expect(failed.payload.error).toContain("daytona exploded");
  });

  test("teardown: responds with no error on success", async () => {
    const h = makeHarness();
    const session = new RemoteSandboxSession({
      emit: h.emit,
      logger: noopLogger,
      resolveOriginUrl: async () => "https://github.com/acme/app.git",
      provisioner: okProvisioner,
    });
    await session.handleTeardownRequest({
      type: "remote.sandbox.teardown.request",
      payload: { requestId: "t1", sandboxId: "s1" },
    });
    const res = h.emitted.at(-1);
    expect(res?.type).toBe("remote.sandbox.teardown.response");
    if (res?.type !== "remote.sandbox.teardown.response") throw new Error("bad res");
    expect(res.payload).toEqual({ requestId: "t1", error: null });
  });

  test("unconfigured daemon: provision request is rejected with an error response", async () => {
    const h = makeHarness();
    const session = new RemoteSandboxSession({
      emit: h.emit,
      logger: noopLogger,
      resolveOriginUrl: async () => "https://github.com/acme/app.git",
      provisioner: null,
    });
    await session.handleProvisionRequest({
      type: "remote.sandbox.provision.request",
      payload: { requestId: "r1", cwd: "/home/me/app" },
    });
    const res = h.emitted[0];
    if (res?.type !== "remote.sandbox.provision.response") throw new Error("bad res");
    expect(res.payload.error).toMatch(/not configured/);
    // no progress events when unconfigured
    expect(h.emitted.filter((m) => m.type === "remote.sandbox.provision.progress")).toHaveLength(0);
  });
});
