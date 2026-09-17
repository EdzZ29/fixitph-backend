/**
 * Magic-byte sniffing for the exact set of file types this platform accepts.
 *
 * A dedicated detector library would work too, but the modern ones are ESM
 * only and this build is CommonJS. More to the point: a general detector
 * recognises hundreds of types you then have to reject anyway. An explicit
 * allow-list is smaller, has no dependency, and is what the security design
 * actually calls for, which is trusting the bytes rather than the filename.
 */

export interface DetectedType {
  mime: string;
  extension: string;
}

type Signature = {
  mime: string;
  extension: string;
  /** Byte pattern; null means "any byte at this position". */
  magic: (number | null)[];
  offset?: number;
  /** Extra predicate for containers where the magic alone is ambiguous. */
  verify?: (buf: Buffer) => boolean;
};

const SIGNATURES: Signature[] = [
  { mime: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    extension: 'png',
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // RIFF....WEBP
  {
    mime: 'image/webp',
    extension: 'webp',
    magic: [0x52, 0x49, 0x46, 0x46],
    verify: (buf) =>
      buf.length > 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  // ....ftypheic / heix / hevc / mif1
  {
    mime: 'image/heic',
    extension: 'heic',
    offset: 4,
    magic: [0x66, 0x74, 0x79, 0x70],
    verify: (buf) => {
      if (buf.length < 12) return false;
      const brand = buf.subarray(8, 12).toString('ascii');
      return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    },
  },
  {
    mime: 'application/pdf',
    extension: 'pdf',
    magic: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
];

/** Returns the detected type, or null when the bytes match nothing allowed. */
export function detectFileType(buffer: Buffer): DetectedType | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.magic.length) continue;

    let matched = true;
    for (let i = 0; i < sig.magic.length; i++) {
      const expected = sig.magic[i];
      if (expected !== null && buffer[offset + i] !== expected) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (sig.verify && !sig.verify(buffer)) continue;

    return { mime: sig.mime, extension: sig.extension };
  }
  return null;
}

export const IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;
export const DOCUMENT_MIMES = [...IMAGE_MIMES, 'application/pdf'] as const;

/**
 * SVG is deliberately absent. It is a script-capable document, and serving one
 * from a user-controlled bucket is a stored XSS waiting to happen.
 */
export function isAllowed(mime: string, allowed: readonly string[]): boolean {
  return allowed.includes(mime);
}
