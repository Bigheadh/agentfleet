/** Native dialogs: RN Alert + biometric confirmation for high-risk approvals. */
import * as LocalAuthentication from "expo-local-authentication";
import { Alert } from "react-native";

import { t } from "../i18n/strings";

export function alertMessage(title: string, message?: string): void {
  Alert.alert(title, message);
}

export function confirmAsync(
  title: string,
  message: string,
  opts: { confirmText?: string; destructive?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: t.common.cancel, style: "cancel", onPress: () => resolve(false) },
        {
          text: opts.confirmText ?? t.common.confirm,
          style: opts.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Confirmation for `danger`-risk approvals (design doc §7): biometric /
 * device-passcode authentication when enrolled, otherwise a confirm dialog.
 */
export async function confirmDanger(title: string): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (hasHardware && enrolled) {
      const ok = await confirmAsync(t.approval.dangerConfirmTitle, t.approval.dangerConfirm(title), {
        destructive: true,
      });
      if (!ok) return false;
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: t.approval.biometricPrompt,
        cancelLabel: t.common.cancel,
      });
      if (!res.success) alertMessage(t.approval.authFailed);
      return res.success;
    }
  } catch {
    // Fall through to the plain dialog.
  }
  return confirmAsync(t.approval.dangerConfirmTitle, t.approval.dangerConfirm(title), { destructive: true });
}
