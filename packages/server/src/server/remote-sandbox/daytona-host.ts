import { Daytona, Image } from "@daytona/sdk";

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
const DOCKERFILE_PREFIX = "dockerfile:";
// Building from a Dockerfile the first time is slow (rust/go/node); Daytona
// caches the result so later provisions reuse it. A registry ref boots fast.
const REGISTRY_CREATE_TIMEOUT_S = 180;
const BUILD_CREATE_TIMEOUT_S = 1800;

/**
 * Resolve the image ref. A `dockerfile:<path>` ref builds via
 * `Image.fromDockerfile` (Daytona builds + caches it, no registry publish);
 * anything else is a registry/snapshot ref.
 */
function resolveImage(ref: string): { image: string | Image; timeoutSeconds: number } {
  if (ref.startsWith(DOCKERFILE_PREFIX)) {
    return {
      image: Image.fromDockerfile(ref.slice(DOCKERFILE_PREFIX.length)),
      timeoutSeconds: BUILD_CREATE_TIMEOUT_S,
    };
  }
  return { image: ref, timeoutSeconds: REGISTRY_CREATE_TIMEOUT_S };
}

/**
 * Daytona-backed {@link SandboxHost}. The image is a registry/snapshot ref (fast
 * boot) or a `dockerfile:<path>` ref that Daytona builds and caches. Validated
 * end-to-end by the spike (scripts/remote-sandbox-spike.ts).
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
      const { image, timeoutSeconds } = resolveImage(opts.image);
      const sandbox = await daytona.create(
        {
          image,
          envVars: opts.env,
          resources: opts.resources ?? DEFAULT_RESOURCES,
          autoStopInterval: opts.autoStopMinutes ?? 15,
          autoDeleteInterval: opts.autoDeleteMinutes ?? 60,
        },
        { timeout: timeoutSeconds },
      );
      return wrap(sandbox);
    },
    destroy: async (id: string): Promise<void> => {
      const sandbox = await daytona.get(id);
      await sandbox.delete();
    },
  };
}
