import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ApiError } from '../common/errors';
import { DOCUMENT_MIMES, detectFileType, isAllowed } from './file-type';
import {
  LocalStorageDriver,
  S3StorageDriver,
  type StorageDriver,
} from './storage';

export interface StoredObject {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  originalFilename: string;
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly driver: StorageDriver;
  private readonly bucket: string;
  private readonly signedUrlTtl: number;
  private readonly maxBytes: number;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET', 'fixitph-private');
    this.signedUrlTtl = config.get<number>('SIGNED_URL_TTL_SECONDS', 300);
    this.maxBytes = config.get<number>('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);

    this.driver = this.buildDriver();
    this.logger.log(`Uploads are stored in ${this.driver.name}.`);
    if (this.driver instanceof LocalStorageDriver) this.driver.logLocation();
  }

  /**
   * Chooses where files go.
   *
   * STORAGE_DRIVER decides it outright. Left unset, the object store is used
   * when it has actually been configured and local disk otherwise — so a
   * checkout with no S3 settings works immediately, instead of failing every
   * upload with a connection error, which is what used to happen.
   *
   * It never falls back at runtime. A deployment that loses its bucket
   * mid-flight has to fail loudly, not quietly start writing somewhere else
   * and split the files across two places.
   *
   * Read once, at boot. Changing STORAGE_DRIVER means restarting the API —
   * the config is cached, so editing .env under a running process has no
   * effect and the old driver stays in use.
   */
  private buildDriver(): StorageDriver {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');

    const configured = this.config.get<string>('STORAGE_DRIVER')?.toLowerCase();
    const chosen =
      configured === 's3' || configured === 'local'
        ? configured
        : accessKeyId && secretAccessKey
          ? 's3'
          : 'local';

    if (chosen === 's3') {
      return S3StorageDriver.create({
        region: this.config.get<string>('S3_REGION', 'ap-southeast-1'),
        endpoint,
        // MinIO and most S3-compatible dev servers need path style addressing.
        forcePathStyle: this.config.get('S3_FORCE_PATH_STYLE') === 'true',
        accessKeyId,
        secretAccessKey,
        bucket: this.bucket,
      });
    }

    return new LocalStorageDriver(
      resolve(
        process.cwd(),
        this.config.get<string>('LOCAL_STORAGE_PATH', 'storage/uploads'),
      ),
      // Reuses the access-token secret: already required, already long, and
      // already rotated with the deployment. A separate one would be another
      // thing to forget to set.
      this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      withoutTrailingSlash(
        this.config.get<string>('PUBLIC_API_URL', 'http://localhost:4000/api'),
      ),
    );
  }

  /** Lets the controller serve a locally stored file behind a signed link. */
  get localDriver(): LocalStorageDriver | null {
    return this.driver instanceof LocalStorageDriver ? this.driver : null;
  }

  /**
   * Validates and stores one file.
   *
   * The declared Content-Type and the filename extension are both treated as
   * hints from an attacker. Only the leading bytes decide what this is, and a
   * file whose bytes are not on the allow-list is rejected outright.
   */
  async store(
    file: UploadedFile,
    prefix: string,
    allowed: readonly string[] = DOCUMENT_MIMES,
  ): Promise<StoredObject> {
    if (!file?.buffer?.length) {
      throw ApiError.badRequest('EMPTY_FILE', 'The uploaded file is empty.');
    }
    if (file.size > this.maxBytes) {
      throw new ApiError(
        'FILE_TOO_LARGE',
        `Files have to be ${Math.floor(this.maxBytes / 1024 / 1024)}MB or smaller.`,
        413,
      );
    }

    const detected = detectFileType(file.buffer);
    if (!detected) {
      throw new ApiError(
        'UNSUPPORTED_FILE_TYPE',
        'That file type is not accepted. Use JPEG, PNG, WebP, HEIC or PDF.',
        415,
      );
    }
    if (!isAllowed(detected.mime, allowed)) {
      throw new ApiError(
        'UNSUPPORTED_FILE_TYPE',
        `A ${detected.mime} file is not accepted here.`,
        415,
      );
    }

    // Worth logging: a mismatch is either a broken client or someone trying to
    // smuggle a payload past an extension check.
    if (file.mimetype && file.mimetype !== detected.mime) {
      this.logger.warn(
        `Declared type ${file.mimetype} does not match detected ${detected.mime} for "${file.originalname}"`,
      );
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    // The key is generated, never derived from the uploaded filename, so a
    // name like "../../etc/passwd" has nowhere to go.
    const storageKey = `${prefix}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${detected.extension}`;

    try {
      await this.driver.put(storageKey, file.buffer, detected.mime);
    } catch (cause) {
      throw this.storageFailure(cause, 'store');
    }

    return {
      storageKey,
      mimeType: detected.mime,
      sizeBytes: file.size,
      checksumSha256: checksum,
      originalFilename: sanitiseFilename(file.originalname),
    };
  }

  /**
   * A storage key is never returned to a client. This exchanges one for a URL
   * that stops working in a few minutes.
   */
  async signedUrl(
    storageKey: string,
    downloadName?: string,
  ): Promise<{ url: string; expiresIn: number }> {
    // Signing reaches no network on either driver, so it cannot fail on
    // connectivity. Wrapped because a misconfigured client (no credentials,
    // bad region) throws here and should read the same way.
    const url = await this.driver.signedUrl(
      storageKey,
      this.signedUrlTtl,
      downloadName ? sanitiseFilename(downloadName) : undefined,
    );
    return { url, expiresIn: this.signedUrlTtl };
  }

  /**
   * Turns a storage fault into something the caller can act on.
   *
   * Object storage being unreachable is an operational problem, not a bad
   * request, and it used to surface as a bare 500 INTERNAL_ERROR — which told
   * a provider staring at a failed photo upload nothing at all, and told
   * whoever was on call nothing either. A 503 with a plain message is honest
   * about whose fault it is and that retrying later is the right move.
   *
   * The underlying error is logged rather than returned: it carries the
   * bucket endpoint and credentials shape, which are not the client's
   * business.
   */
  private storageFailure(cause: unknown, operation: string): ApiError {
    const offline =
      cause instanceof Error &&
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(
        `${cause.name} ${cause.message} ${'code' in cause ? String(cause.code) : ''}`,
      );

    this.logger.error(
      `Storage ${operation} failed${offline ? ' (storage unreachable)' : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );

    return new ApiError(
      offline ? 'STORAGE_UNAVAILABLE' : 'STORAGE_FAILED',
      offline
        ? 'File storage is not reachable right now, so the upload could not be saved. Please try again shortly.'
        : 'The file could not be saved. Please try again.',
      503,
    );
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await this.driver.remove(storageKey);
    } catch (cause) {
      // A failed delete leaves an orphan, which is untidy but harmless: the
      // row that pointed at it has already moved on. Never worth failing the
      // request the caller actually made.
      this.logger.warn(
        `Could not remove ${storageKey}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

/** "http://host/api/" -> "http://host/api", so joining a path is predictable. */
function withoutTrailingSlash(url: string): string {
  let trimmed = url;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/** Strips path separators and control characters from a client-supplied name. */
function sanitiseFilename(name: string): string {
  return (
    (name || 'file')
      .replace(/[\\/]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f"]/g, '')
      .slice(0, 200)
  );
}
