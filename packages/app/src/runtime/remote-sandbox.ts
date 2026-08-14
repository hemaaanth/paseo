// FORK: remote sandbox. Drives the `remote.sandbox.provision` RPC end-to-end and
// keeps all remote-workspace logic in this one file (session-context and the
// New Workspace screen only reference it). Flow: kick off provisioning on the
// local daemon → stream progress → on completion connect to the sandbox daemon,
// create the workspace + first agent there, and navigate to it.
import { useCallback, useEffect, useRef, useState } from "react";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RemoteSandboxConnection } from "@getpaseo/protocol/messages";

import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

const SANDBOX_DAEMON_PORT = 6767;
const SANDBOX_REPO_DIR = "/workspace/repo";

export type RemoteProvisionState =
  | { status: "idle" }
  | { status: "provisioning"; step?: string; detail?: string }
  | { status: "error"; message: string };

export interface RemoteProvisionInput {
  /** The LOCAL daemon client that owns the provisioning creds. */
  client: DaemonClient;
  /** Local project checkout path; the daemon resolves its git origin to clone. */
  cwd: string;
  branch?: string;
  prompt: string;
}

function labelFor(cwd: string): string {
  const name = cwd.replace(/\/+$/, "").split("/").pop() || "repo";
  return `Remote · ${name}`;
}

export function useRemoteSandboxProvision(): {
  state: RemoteProvisionState;
  provision: (input: RemoteProvisionInput) => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<RemoteProvisionState>({ status: "idle" });
  const unsubscribe = useRef<(() => void) | null>(null);

  const stopListening = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
  }, []);

  const reset = useCallback(() => {
    stopListening();
    setState({ status: "idle" });
  }, [stopListening]);

  useEffect(() => stopListening, [stopListening]);

  const finalize = useCallback(
    async (connection: RemoteSandboxConnection, input: RemoteProvisionInput) => {
      try {
        setState({ status: "provisioning", step: "Connecting to sandbox" });
        const store = getHostRuntimeStore();
        const { serverId } = await store.probeAndUpsertDirectConnection({
          endpoint: `${connection.tailnetIp}:${SANDBOX_DAEMON_PORT}`,
          useTls: false,
          password: connection.password,
          label: labelFor(input.cwd),
          hidden: true, // keep the ephemeral sandbox out of the host switcher
        });
        const sandboxClient = store.getClient(serverId);
        if (!sandboxClient) throw new Error("could not connect to the remote sandbox");
        const prompt = input.prompt.trim();
        const payload = await sandboxClient.createWorkspace({
          source: { kind: "directory", path: SANDBOX_REPO_DIR },
          ...(prompt ? { firstAgentContext: { prompt } } : {}),
        });
        if (payload.error || !payload.workspace) {
          throw new Error(payload.error ?? "workspace creation failed on the sandbox");
        }
        navigateToWorkspace({ serverId, workspaceId: payload.workspace.id });
        setState({ status: "idle" });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  const provision = useCallback(
    async (input: RemoteProvisionInput) => {
      stopListening();
      setState({ status: "provisioning", step: "Requesting sandbox" });
      let provisionId: string | null = null;
      const off = input.client.on("remote.sandbox.provision.progress", (message) => {
        const progress = message.payload;
        if (provisionId && progress.provisionId !== provisionId) return;
        if (progress.status === "running") {
          setState({ status: "provisioning", step: progress.step, detail: progress.detail });
        } else if (progress.status === "failed") {
          stopListening();
          setState({ status: "error", message: progress.error ?? "Provisioning failed" });
        } else if (progress.status === "completed" && progress.connection) {
          stopListening();
          void finalize(progress.connection, input);
        }
      });
      unsubscribe.current = off;

      try {
        const ack = await input.client.provisionRemoteSandbox({
          cwd: input.cwd,
          ...(input.branch ? { branch: input.branch } : {}),
        });
        provisionId = ack.provisionId;
        if (ack.error) {
          stopListening();
          setState({ status: "error", message: ack.error });
        }
      } catch (error) {
        stopListening();
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [finalize, stopListening],
  );

  return { state, provision, reset };
}
