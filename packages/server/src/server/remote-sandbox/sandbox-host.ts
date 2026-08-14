/**
 * Host-neutral sandbox interface. Daytona is the first implementation; e2b/etc.
 * become a second `implements` without touching the provisioner. Keep this
 * surface small — it is the only thing the provisioner depends on.
 */

export interface CreateSandboxOptions {
  /** Registry image or snapshot ref the box boots from (e.g. paseo-sandbox:0.4.0). */
  image: string;
  /** Environment variables set in the box (PASEO_PASSWORD, PASEO_LISTEN, …). */
  env: Record<string, string>;
  resources?: { cpu: number; memory: number; disk: number };
  /** Auto-stop after N idle minutes (provider backstop). */
  autoStopMinutes?: number;
  /** Auto-delete N minutes after stopping. */
  autoDeleteMinutes?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  output: string;
}

export interface SandboxHandle {
  id: string;
  /** Run a shell command in the box and return its exit code + combined output. */
  exec(command: string): Promise<SandboxExecResult>;
  /** HTTPS base URL for a port exposed inside the box (provider preview proxy). */
  previewUrl(port: number): Promise<string>;
}

export interface SandboxHost {
  create(options: CreateSandboxOptions): Promise<SandboxHandle>;
  /** Tear a box down by id (used by teardown; the handle is not retained). */
  destroy(id: string): Promise<void>;
}
