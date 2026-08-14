import { Daytona } from "@daytona/sdk";

import type {
  CreateSandboxOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxHost,
} from "./sandbox-host.js";

export interface DaytonaHostOptions {
  /** Defaults to the DAYTONA_API_KEY env var (read by the SDK). */
  apiKey?: string;
  /** Defaults to the DAYTONA_API_URL env var / the SDK default. */
  apiUrl?: string;
}

const DEFAULT_RESOURCES = { cpu: 2, memory: 4, disk: 10 };

/**
 * Daytona-backed {@link SandboxHost}. The image is a pre-built snapshot ref, so
 * boxes boot fast — no per-provision build. Validated end-to-end by the spike
 * (scripts/remote-sandbox-spike.ts) and docs/remote-sandbox-spike.md.
 */
export function createDaytonaHost(options: DaytonaHostOptions = {}): SandboxHost {
  const daytona = new Daytona(
    options.apiKey ? { apiKey: options.apiKey, apiUrl: options.apiUrl } : undefined,
  );

  function wrap(sandbox: Awaited<ReturnType<Daytona["create"]>>): SandboxHandle {
    return {
      id: sandbox.id,
      exec: async (command): Promise<SandboxExecResult> => {
        const res = await sandbox.process.executeCommand(command);
        return { exitCode: res.exitCode, output: String(res.result ?? "") };
      },
      previewUrl: async (port) => (await sandbox.getPreviewLink(port)).url,
    };
  }

  return {
    create: async (opts: CreateSandboxOptions): Promise<SandboxHandle> => {
      const sandbox = await daytona.create({
        image: opts.image,
        envVars: opts.env,
        resources: opts.resources ?? DEFAULT_RESOURCES,
        autoStopInterval: opts.autoStopMinutes ?? 15,
        autoDeleteInterval: opts.autoDeleteMinutes ?? 60,
      });
      return wrap(sandbox);
    },
    destroy: async (id: string): Promise<void> => {
      const sandbox = await daytona.get(id);
      await sandbox.delete();
    },
  };
}
