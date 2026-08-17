import { Daytona, Image } from "@daytona/sdk";

import type {
  CreateSandboxOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxHost,
  SandboxStatus,
} from "./sandbox-host.js";

export interface DaytonaHostOptions {
  /** Defaults to the DAYTONA_API_KEY env var (read by the SDK). */
  apiKey?: string;
  /** Defaults to the DAYTONA_API_URL env var / the SDK default. */
  apiUrl?: string;
}

const DEFAULT_RESOURCES = { cpu: 2, memory: 4, disk: 10 };
// Bound every exec so a stuck command (e.g. a hung `tailscale up`) fails instead
// of wedging the whole provision. Covers the slowest legit step with margin.
const DEFAULT_EXEC_TIMEOUT_S = 150;
const SNAPSHOT_PREFIX = "snapshot:";
const DOCKERFILE_PREFIX = "dockerfile:";
// A pre-built snapshot / registry image boots fast; building from a Dockerfile
// the first time is slow (rust/go/node) though Daytona caches the result.
const FAST_CREATE_TIMEOUT_S = 180;
const BUILD_CREATE_TIMEOUT_S = 1800;

/**
 * Daytona-backed {@link SandboxHost}. `opts.image` selects how the box is built:
 *   - `snapshot:<name>` — boot from a pre-built Daytona snapshot (fastest; build
 *     it once with `daytona.snapshot.create`). Recommended for real use.
 *   - `dockerfile:<path>` — Daytona builds + caches the image from a Dockerfile
 *     (slow first provision, no registry publish).
 *   - `<ref>` — a registry image ref.
 * Validated end-to-end by the spike (scripts/remote-sandbox-spike.ts).
 */
export function createDaytonaHost(options: DaytonaHostOptions = {}): SandboxHost {
  const daytona = new Daytona(
    options.apiKey ? { apiKey: options.apiKey, apiUrl: options.apiUrl } : undefined,
  );

  function wrap(sandbox: Awaited<ReturnType<Daytona["create"]>>): SandboxHandle {
    return {
      id: sandbox.id,
      exec: async (command, timeoutS): Promise<SandboxExecResult> => {
        const res = await sandbox.process.executeCommand(
          command,
          undefined,
          undefined,
          timeoutS ?? DEFAULT_EXEC_TIMEOUT_S,
        );
        return { exitCode: res.exitCode, output: String(res.result ?? "") };
      },
      previewUrl: async (port) => (await sandbox.getPreviewLink(port)).url,
    };
  }

  return {
    create: async (opts: CreateSandboxOptions): Promise<SandboxHandle> => {
      const base = {
        envVars: opts.env,
        autoStopInterval: opts.autoStopMinutes ?? 15,
        autoDeleteInterval: opts.autoDeleteMinutes ?? 60,
      };
      // A snapshot bakes in its own resources; Daytona rejects create() if you
      // also pass `resources`. Only the image/dockerfile paths set them.
      const resources = opts.resources ?? DEFAULT_RESOURCES;
      const ref = opts.image;
      // Branch the call (not a union param) so the SDK overload resolves cleanly.
      if (ref.startsWith(SNAPSHOT_PREFIX)) {
        const sandbox = await daytona.create(
          { ...base, snapshot: ref.slice(SNAPSHOT_PREFIX.length) },
          { timeout: FAST_CREATE_TIMEOUT_S },
        );
        return wrap(sandbox);
      }
      if (ref.startsWith(DOCKERFILE_PREFIX)) {
        const sandbox = await daytona.create(
          { ...base, resources, image: Image.fromDockerfile(ref.slice(DOCKERFILE_PREFIX.length)) },
          { timeout: BUILD_CREATE_TIMEOUT_S },
        );
        return wrap(sandbox);
      }
      const sandbox = await daytona.create(
        { ...base, resources, image: ref },
        { timeout: FAST_CREATE_TIMEOUT_S },
      );
      return wrap(sandbox);
    },
    destroy: async (id: string): Promise<void> => {
      const sandbox = await daytona.get(id);
      await sandbox.delete();
    },
    status: async (id: string): Promise<SandboxStatus> => {
      let sandbox: Awaited<ReturnType<Daytona["get"]>>;
      try {
        sandbox = await daytona.get(id);
      } catch {
        // get() throws once the box is fully removed from the account.
        return "deleted";
      }
      // Daytona "stopped"/"archived" both keep the filesystem and can restart;
      // only a delete is unrecoverable (and then get() throws, handled above).
      const state = String(sandbox.state ?? "");
      if (state === "started") return "running";
      if (state === "stopped" || state === "archived") return "suspended";
      if (state === "destroyed" || state === "deleted") return "deleted";
      return "unknown";
    },
    resume: async (id: string): Promise<void> => {
      const sandbox = await daytona.get(id);
      await sandbox.start();
    },
    check: async (): Promise<void> => {
      // Lists sandboxes on the account; a bad API key / URL throws (401/network).
      await daytona.list();
    },
  };
}
