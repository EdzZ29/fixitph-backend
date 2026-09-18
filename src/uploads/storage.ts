import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/**
 * Where uploaded files actually live.
 *
 * Two drivers behind one interface. S3 (or MinIO, or any S3-compatible
 * service) is what production uses. `local` writes to a directory on disk and
 * is there so that a developer can upload a profile photo without running an
 * object store — which, before this existed, meant uploads simply did not
 * work on a machine without Docker.
 *
 * Both keep the same promises, which is the point of doing it this way rather
 * than special-casing dev: files are private, a storage key is never handed
 * to a client, and the only way to read one is a URL that stops working after
 * a few minutes.
 */
export interface StorageDriver {
  readonly name: 'the object store' | 'local disk';

  /**
   * The content type is advisory: S3 stores it as object metadata, and the
   * local driver has nowhere to put it, so it is optional on the interface.
   */
  put(key: string, body: Buffer, contentType?: string): Promise<void>;

  /** A URL that works for a short time and then does not. */
  signedUrl(
    key: string,
    ttlSeconds: number,
    downloadName?: string,
  ): Promise<string>;

  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

export class S3StorageDriver implements StorageDriver {
  readonly name = 'the object store' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static create(options: {
    region: string;
    endpoint?: string;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket: string;
  }): S3StorageDriver {
    const client = new S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      forcePathStyle: options.forcePathStyle,
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),

      /**
       * Fail fast when storage is unreachable.
       *
       * The SDK's defaults assume a flaky network in front of a bucket that
       * exists: three attempts with backoff and no connect timeout. Against a
       * host that is simply not listening, that turns a refused connection
       * into a request that hangs for most of a minute while somebody watches
       * a spinner.
       */
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3_000,
        requestTimeout: 30_000,
      }),
    });

    return new S3StorageDriver(client, options.bucket);
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Forces a download rather than inline rendering, which neutralises
        // anything that slipped through pretending to be an image.
        ContentDisposition: 'attachment',
      }),
    );
  }

  async signedUrl(
    key: string,
    ttlSeconds: number,
    downloadName?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(downloadName
          ? {
              ResponseContentDisposition: `attachment; filename="${downloadName}"`,
            }
          : {}),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

/**
 * Files on disk, served back through the API behind a signed link.
 *
 * The signature is the part that matters. The directory is not exposed by the
 * web server and there is no path that takes a storage key, so the only way
 * to read a file is a link this driver minted: an HMAC over the key and an
 * expiry, verified on the way back in. That gives local development the same
 * "private, and links expire" behaviour as the bucket, rather than a
 * public folder that behaves differently from production.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local disk' as const;
  private readonly logger = new Logger(LocalStorageDriver.name);

  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
  ) {}

  /**
   * Resolves a key to a path inside the root, and refuses anything that
   * escapes it.
   *
   * Keys are generated by this application and never taken from a filename,
   * so traversal should be impossible already. This is the second lock: the
   * cost of being wrong here is arbitrary file read and write.
   */
  private pathFor(key: string): string {
    const full = resolve(this.root, normalize(key));
    const base = resolve(this.root);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async signedUrl(
    key: string,
    ttlSeconds: number,
    downloadName?: string,
  ): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.sign(key, expires);

    const params = new URLSearchParams({
      key,
      expires: String(expires),
      signature,
      ...(downloadName ? { name: downloadName } : {}),
    });

    return Promise.resolve(
      `${this.publicBaseUrl}/uploads/local/file?${params.toString()}`,
    );
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  sign(key: string, expires: number): string {
    return createHmac('sha256', this.secret)
      .update(`${key}:${expires}`)
      .digest('base64url');
  }

  /**
   * Whether a link is one we issued and is still in date. Compared in
   * constant time: a leaky comparison here would let a signature be guessed a
   * byte at a time.
   */
  verify(key: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) return false;

    const expected = Buffer.from(this.sign(key, expires));
    const given = Buffer.from(signature);
    if (expected.length !== given.length) return false;

    try {
      return timingSafeEqual(expected, given);
    } catch {
      return false;
    }
  }

  logLocation(): void {
    this.logger.warn(
      `Uploads are being written to local disk at ${join(this.root)}. ` +
        'This is for development without an object store; set STORAGE_DRIVER=s3 for anything shared.',
    );
  }
}
