import { pwaDisplayName } from "./pwa";

interface PasswordCredentialConstructor {
  new(data: {
    id: string;
    name: string;
    password: string;
  }): Credential;
}

type CredentialGlobal = typeof globalThis & {
  PasswordCredential?: PasswordCredentialConstructor;
};

export function credentialUsername(hostname: string): string {
  return `term-server@${hostname.trim() || "localhost"}`;
}

export function rememberPassword(
  password: string,
  hostname: string = location.hostname,
): void {
  const PasswordCredential = (globalThis as CredentialGlobal).PasswordCredential;
  if (!PasswordCredential || !navigator.credentials) return;
  const credential = new PasswordCredential({
    id: credentialUsername(hostname),
    name: pwaDisplayName(hostname),
    password,
  });
  void navigator.credentials.store(credential).catch(() => undefined);
}
