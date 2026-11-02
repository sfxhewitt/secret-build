import { sanitizePatch } from './patch';
import type { Patch } from './types';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const canCompress = (): boolean => typeof CompressionStream !== 'undefined';

/**
 * Serialises a patch into a URL-safe token. A patch is ~1 KB of JSON and
 * deflates to a few hundred bytes, so a whole sound fits in a link.
 * Format: "z" + base64url(deflate-raw(json)) or "j" + base64url(json).
 */
export async function encodePatch(patch: Patch): Promise<string> {
  const json = JSON.stringify(patch);
  const bytes = new TextEncoder().encode(json);
  if (canCompress()) return 'z' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
  return 'j' + toBase64Url(bytes);
}

/** Inverse of encodePatch. Always returns a sanitised patch; throws on garbage. */
export async function decodePatch(token: string): Promise<Patch> {
  const kind = token[0];
  const raw = fromBase64Url(token.slice(1));
  let bytes: Uint8Array;
  if (kind === 'z') bytes = await pipe(raw, new DecompressionStream('deflate-raw'));
  else if (kind === 'j') bytes = raw;
  else throw new Error('Unknown share format');
  return sanitizePatch(JSON.parse(new TextDecoder().decode(bytes)));
}
