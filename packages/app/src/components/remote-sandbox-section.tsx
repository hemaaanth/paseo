// FORK: remote sandbox. The "Remote" toggle + provisioning progress/error banner
// for the New Workspace screen, extracted so the screen stays under its
// complexity budget. All remote logic lives in @/runtime/remote-sandbox.
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
  state: RemoteProvisionState;
}

export function RemoteSandboxSection({
  supported,
  enabled,
  onToggle,
  disabled,
  state,
}: RemoteSandboxSectionProps): ReactElement | null {
  if (!supported && state.status === "idle") {
    return null;
  }
  return (
    <View>
      {supported ? (
        <View style={styles.row}>
          <View style={styles.textColumn}>
            <Text style={styles.label}>Remote sandbox</Text>
            <Text style={styles.description}>Run this workspace in a disposable cloud sandbox</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={onToggle}
            disabled={disabled}
            accessibilityLabel="Provision this workspace in a remote sandbox"
          />
        </View>
      ) : null}
      {state.status === "provisioning" ? (
        <Text style={styles.status}>
          {state.step ?? "Provisioning…"}
          {state.detail ? ` — ${state.detail}` : ""}
        </Text>
      ) : null}
      {state.status === "error" ? <Text style={styles.error}>{state.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[4],
    marginBottom: theme.spacing[4],
    gap: theme.spacing[4],
  },
  textColumn: {
    flex: 1,
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  status: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[4],
    marginBottom: theme.spacing[2],
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    paddingLeft: theme.spacing[4],
    marginBottom: theme.spacing[2],
  },
}));
