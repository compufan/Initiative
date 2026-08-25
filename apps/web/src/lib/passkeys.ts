import { api } from './api.js';

/**
 * Anmelden mit Face ID, Fingerabdruck oder Geräte-PIN.
 *
 * Der Browser liefert und erwartet rohe Bytes (`ArrayBuffer`), der Server
 * spricht base64url. Die Umrechnung passiert hier an genau einer Stelle.
 */

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ersetzt die base64url-Felder der Server-Optionen durch echte Bytes. */
function decodeCreateOptions(options: any): CredentialCreationOptions {
  const publicKey = options.publicKey ?? options;
  return {
    publicKey: {
      ...publicKey,
      challenge: fromBase64Url(publicKey.challenge),
      user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) },
      excludeCredentials: (publicKey.excludeCredentials ?? []).map((item: any) => ({
        ...item,
        id: fromBase64Url(item.id),
      })),
    },
  };
}

function decodeRequestOptions(options: any): CredentialRequestOptions {
  const publicKey = options.publicKey ?? options;
  return {
    publicKey: {
      ...publicKey,
      challenge: fromBase64Url(publicKey.challenge),
      allowCredentials: (publicKey.allowCredentials ?? []).map((item: any) => ({
        ...item,
        id: fromBase64Url(item.id),
      })),
    },
  };
}

/** Ob das Gerät überhaupt einen eingebauten Sensor anbietet. */
export async function passkeysUsable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Sinnvoller Name für die Liste, damit man Geräte auseinanderhält. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android-Gerät';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows-PC';
  return 'Dieses Gerät';
}

export async function registerPasskey(label?: string) {
  const start = await api.passkeys.registerStart();
  const credential = (await navigator.credentials.create(
    decodeCreateOptions(start.options),
  )) as PublicKeyCredential | null;
  if (!credential) throw new Error('Es wurde kein Schlüssel angelegt.');

  const response = credential.response as AuthenticatorAttestationResponse;
  return api.passkeys.registerFinish({
    requestId: start.requestId,
    label: label ?? deviceLabel(),
    credential: {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: toBase64Url(response.attestationObject),
        clientDataJSON: toBase64Url(response.clientDataJSON),
      },
      extensions: {},
    },
  });
}

export async function loginWithPasskey(username: string) {
  const start = await api.passkeys.loginStart(username);
  const credential = (await navigator.credentials.get(
    decodeRequestOptions(start.options),
  )) as PublicKeyCredential | null;
  if (!credential) throw new Error('Anmeldung abgebrochen.');

  const response = credential.response as AuthenticatorAssertionResponse;
  return api.passkeys.loginFinish({
    requestId: start.requestId,
    credential: {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      response: {
        authenticatorData: toBase64Url(response.authenticatorData),
        clientDataJSON: toBase64Url(response.clientDataJSON),
        signature: toBase64Url(response.signature),
        userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
      },
      extensions: {},
    },
  });
}
