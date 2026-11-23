/** Web dialogs: RN-web's Alert is a no-op, so use the browser's built-ins. */
import { t } from "../i18n/strings";

export function alertMessage(title: string, message?: string): void {
  window.alert(message ? `${title}\n\n${message}` : title);
}

export async function confirmAsync(
  title: string,
  message: string,
  _opts: { confirmText?: string; destructive?: boolean } = {},
): Promise<boolean> {
  return window.confirm(`${title}\n\n${message}`);
}

export async function confirmDanger(title: string): Promise<boolean> {
  return window.confirm(`${t.approval.dangerConfirmTitle}\n\n${t.approval.dangerConfirm(title)}`);
}
