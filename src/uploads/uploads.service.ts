import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors';
import { DOCUMENT_MIMES, detectFileType, isAllowed } from './file-type';

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
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtl: number;
  private readonly maxBytes: number;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET', 'fixitph-private');
    this.signedUrlTtl = config.get<number>('SIGNED_URL_TTL_SECONDS', 300);
    this.maxBytes = config.get<number>('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);

    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');

    this.client = new S3Client({
      region: config.get<string>('S3_REGION', 'ap-southeast-1'),
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      // MinIO and most S3-compatible dev servers need path style addressing.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE') === 'true',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
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

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: file.buffer,
        ContentType: detected.mime,
        // Forces a download rather than inline rendering, which neutralises
        // anything that slipped through pretending to be an image.
        ContentDisposition: 'attachment',
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        Metadata: { 'original-filename': sanitiseFilename(file.originalname) },
      }),
    );

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
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ...(downloadName
          ? {
              ResponseContentDisposition: `attachment; filename="${sanitiseFilename(downloadName)}"`,
            }
          : {}),
      }),
      { expiresIn: this.signedUrlTtl },
    );
    return { url, expiresIn: this.signedUrlTtl };
  }

  async remove(storageKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
  }
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
