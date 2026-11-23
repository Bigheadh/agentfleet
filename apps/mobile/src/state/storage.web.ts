/**
 * Web fallback: expo-secure-store has no web implementation, so use
 * localStorage (Metro picks this file over storage.ts for the web bundle).
 */
const ls = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export async function getItem(key: string): Promise<string | null> {
  return ls()?.getItem(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  ls()?.setItem(key, value);
}

export async function removeItem(key: string): Promise<void> {
  ls()?.removeItem(key);
}
