// FORK: remote sandbox — settings page to configure the sandbox provider. Reads
// the redacted config (secrets shown as "configured", never their value) and
// saves via the write-only patch (a secret you don't re-type is kept).
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type {
  RemoteSandboxConfigPatch,
  RemoteSandboxRedactedConfig,
} from "@getpaseo/protocol/messages";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";

function secretPlaceholder(configured: boolean): string {
  return configured ? "•••••••• configured — type to replace" : "not set";
}

export function RemoteSandboxSettingsPage({ serverId }: { serverId: string }) {
  const [config, setConfig] = useState<RemoteSandboxRedactedConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [daytonaApiKey, setDaytonaApiKey] = useState("");
  const [daytonaApiUrl, setDaytonaApiUrl] = useState("");
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState("");
  const [tailscaleTag, setTailscaleTag] = useState("");
  const [image, setImage] = useState("");

  const applyLoaded = useCallback((loaded: RemoteSandboxRedactedConfig) => {
    setConfig(loaded);
    setDaytonaApiUrl(loaded.daytonaApiUrl ?? "");
    setTailscaleTag(loaded.tailscaleTag ?? "");
    setImage(loaded.image ?? "");
    setDaytonaApiKey("");
    setTailscaleAuthKey("");
  }, []);

  useEffect(() => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      return;
    }
    void client.getRemoteSandboxConfig().then((res) => applyLoaded(res.config));
  }, [serverId, applyLoaded]);

  const save = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      return;
    }
    setSaving(true);
    try {
      const patch: RemoteSandboxConfigPatch = {
        provider: "daytona",
        daytonaApiUrl: daytonaApiUrl || undefined,
        tailscaleTag: tailscaleTag || undefined,
        image: image || undefined,
        ...(daytonaApiKey ? { daytonaApiKey } : {}),
        ...(tailscaleAuthKey ? { tailscaleAuthKey } : {}),
      };
      const res = await client.setRemoteSandboxConfig(patch);
      if (res.error) {
        throw new Error(res.error);
      }
      applyLoaded(res.config);
      Alert.alert("Saved", "Remote sandbox settings updated.");
    } catch (error) {
      Alert.alert("Couldn't save", error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [serverId, daytonaApiKey, daytonaApiUrl, tailscaleAuthKey, tailscaleTag, image, applyLoaded]);

  if (!config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner color={styles.placeholder.color} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SettingsSection title="Remote sandbox">
        <Text style={styles.desc}>
          Run workspaces in disposable cloud sandboxes. Keys are stored on this daemon and never
          shown back to any client.
        </Text>
        <Field label="Provider">
          <TextInput
            style={[styles.input, styles.inputDisabled]}
            value="Daytona"
            editable={false}
          />
        </Field>
        <Field label="Daytona API key">
          <TextInput
            style={styles.input}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={secretPlaceholder(config.daytonaApiKeyConfigured)}
            placeholderTextColor={styles.placeholder.color}
            value={daytonaApiKey}
            onChangeText={setDaytonaApiKey}
          />
        </Field>
        <Field label="Daytona API URL">
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://app.daytona.io/api"
            placeholderTextColor={styles.placeholder.color}
            value={daytonaApiUrl}
            onChangeText={setDaytonaApiUrl}
          />
        </Field>
        <Field label="Tailscale auth key" hint="Reusable + ephemeral key from your own tailnet.">
          <TextInput
            style={styles.input}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={secretPlaceholder(config.tailscaleAuthKeyConfigured)}
            placeholderTextColor={styles.placeholder.color}
            value={tailscaleAuthKey}
            onChangeText={setTailscaleAuthKey}
          />
        </Field>
        <Field label="Tailscale tag">
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="tag:paseo-sandbox"
            placeholderTextColor={styles.placeholder.color}
            value={tailscaleTag}
            onChangeText={setTailscaleTag}
          />
        </Field>
        <Field label="Sandbox image" hint="Snapshot/image ref the box boots from.">
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="snapshot:paseo-sandbox-0-4-0"
            placeholderTextColor={styles.placeholder.color}
            value={image}
            onChangeText={setImage}
          />
        </Field>
        <View style={styles.actions}>
          <Button variant="default" onPress={save} disabled={saving}>
            <Text style={styles.saveLabel}>{saving ? "Saving…" : "Save"}</Text>
          </Button>
        </View>
      </SettingsSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: theme.spacing[4] },
  desc: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[4],
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputDisabled: { color: theme.colors.foregroundMuted },
  placeholder: { color: theme.colors.foregroundExtraMuted },
  actions: { marginTop: theme.spacing[4], alignItems: "flex-start" },
  saveLabel: { color: theme.colors.background, fontSize: theme.fontSize.sm },
}));
