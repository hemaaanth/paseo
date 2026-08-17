// FORK: remote sandbox. Compact "Remote" toggle for the New Workspace screen.
// Just a label + switch — the provisioning progress/error renders down by the
// composer (see new-workspace-screen), not here. All remote logic lives in
// @/runtime/remote-sandbox.
import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Switch } from "@/components/ui/switch";
import type { RemoteProvisionState } from "@/runtime/remote-sandbox";

interface RemoteSandboxSectionProps {
  supported: boolean;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  disabled: boolean;
}

export function RemoteSandboxSection({
  supported,
  enabled,
  onToggle,
  disabled,
}: RemoteSandboxSectionProps): ReactElement | null {
  if (!supported) {
    return null;
  }
  return (
    <View style={styles.row}>
      <Text style={styles.label}>Remote sandbox</Text>
      <Switch
        value={enabled}
        onValueChange={onToggle}
        disabled={disabled}
        accessibilityLabel="Provision this workspace in a remote sandbox"
      />
    </View>
  );
}

// Provisioning progress / error, rendered down by the composer. Fixed-height slot
// so text arriving never shifts the (vertically centered) block; right-aligned to
// the composer's inner edge. `enabled` gate lives here to keep the caller simple.
export function RemoteProvisionStatusLine({
  state,
  enabled,
}: {
  state: RemoteProvisionState;
  enabled: boolean;
}): ReactElement | null {
  if (!enabled) {
    return null;
  }
  return (
    <View style={styles.statusSlot}>
      {state.status === "provisioning" ? (
        <Text numberOfLines={1} style={styles.statusText}>
          {state.step ?? "Provisioning…"}
          {state.detail ? ` — ${state.detail}` : ""}
        </Text>
      ) : null}
      {state.status === "error" ? (
        <Text numberOfLines={1} style={styles.statusError}>
          {state.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // Match the picker row above: its chips sit at spacing[4] + the chip's own
    // spacing[2] badge padding (= spacing[6]) on the left, and its trailing edge
    // stops on the composer's inner content rather than the container edge. We
    // have no badge, so we inset to spacing[6] directly to line up text with
    // "sher" and pull the toggle in under the composer's send button.
    paddingLeft: theme.spacing[6],
    paddingRight: theme.spacing[6],
    // The picker row above carries marginBottom: spacing[8] (sized for the
    // no-sandbox picker→composer gap). Pull the row up so the picker→sandbox gap
    // is tight and roughly matches the spacing[3] below it, without touching the
    // picker's own spacing.
    marginTop: -theme.spacing[6],
    marginBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  statusSlot: {
    height: theme.spacing[6],
    marginTop: theme.spacing[2],
    justifyContent: "center",
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    paddingRight: theme.spacing[6],
  },
  statusError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    textAlign: "right",
    paddingRight: theme.spacing[6],
  },
}));
