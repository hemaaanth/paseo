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

/**
 * Provider-neutral lifecycle state. Each host maps its own states onto these:
 *   - running: alive and reachable.
 *   - suspended: idled/stopped but its filesystem is preserved and it can resume.
 *   - deleted: gone; unrecoverable.
 *   - unknown: the provider couldn't be reached / an unmapped state.
 */
export type SandboxStatus = "running" | "suspended" | "deleted" | "unknown";

export interface SandboxHandle {
  id: string;
  /**
   * Run a shell command in the box and return its exit code + combined output.
   * `timeoutS` bounds the call so a stuck command can't hang the provision
   * forever; the host applies a default when omitted.
   */
  exec(command: string, timeoutS?: number): Promise<SandboxExecResult>;
  /** HTTPS base URL for a port exposed inside the box (provider preview proxy). */
  previewUrl(port: number): Promise<string>;
}

export interface SandboxHost {
  create(options: CreateSandboxOptions): Promise<SandboxHandle>;
  /** Tear a box down by id (used by teardown; the handle is not retained). */
  destroy(id: string): Promise<void>;
  /** Provider lifecycle state by id. Report "deleted" if the box is gone. */
  status(id: string): Promise<SandboxStatus>;
  /** Wake a suspended box. Throw if the provider can't (or the box is deleted). */
  resume(id: string): Promise<void>;
  /** Cheap auth/reachability probe for a "test connection" button. Throw on failure. */
  check(): Promise<void>;
}
