import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { WRITE_THROTTLE } from '../common/throttle';
import { DocumentType, UserRole, VerificationStatus } from '@prisma/client';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { toAuthContext, type AuthenticatedUser } from '../common/types';
import { IMAGE_MIMES } from './file-type';
import {
  UploadsService,
  type UploadedFile as MulterFile,
} from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Verification documents. Stored in the private bucket; only the owning
   * provider and an admin can ever get a signed URL for one.
   */
  @Post('provider-documents')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @Throttle({ default: WRITE_THROTTLE.upload })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadProviderDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: MulterFile,
    @Query('documentType') documentType: DocumentType,
  ) {
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Create a provider profile first.',
      );
    }
    if (!Object.values(DocumentType).includes(documentType)) {
      throw ApiError.badRequest(
        'INVALID_DOCUMENT_TYPE',
        'Unknown document type.',
      );
    }

    const stored = await this.uploads.store(
      file,
      `provider-documents/${user.providerId}`,
    );

    return this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.providerDocument.create({
        data: {
          providerId: user.providerId!,
          documentType,
          storageKey: stored.storageKey,
          originalFilename: stored.originalFilename,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          checksumSha256: stored.checksumSha256,
          status: VerificationStatus.PENDING,
        },
        // storageKey is deliberately absent from the response.
        select: {
          id: true,
          documentType: true,
          status: true,
          originalFilename: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      }),
    );
  }

  /**
   * The profile photo and the cover image.
   *
   * Both live in the private bucket like everything else and are served as
   * signed URLs — not because they are secret, but because there is one
   * storage path in this system and a second, public one would be a second
   * set of rules to get wrong.
   *
   * Replacing an image deletes the old object rather than orphaning it: these
   * are the two uploads a provider will churn through while setting up.
   */
  @Post('provider-images/:kind')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @Throttle({ default: WRITE_THROTTLE.serviceImage })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadProviderImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (kind !== 'avatar' && kind !== 'cover') {
      throw ApiError.badRequest(
        'INVALID_IMAGE_KIND',
        'Only avatar and cover can be uploaded here.',
      );
    }
    if (!user.providerId) {
      throw ApiError.forbidden(
        'NO_PROVIDER_PROFILE',
        'Create a provider profile first.',
      );
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: user.providerId },
      select: { avatarKey: true, coverKey: true },
    });
    if (!provider) throw ApiError.notFound('PROVIDER_NOT_FOUND');

    const stored = await this.uploads.store(
      file,
      `provider-images/${user.providerId}/${kind}`,
      IMAGE_MIMES,
    );

    const previous = kind === 'avatar' ? provider.avatarKey : provider.coverKey;

    const updated = await this.prisma.provider.update({
      where: { id: user.providerId },
      data:
        kind === 'avatar'
          ? { avatarKey: stored.storageKey }
          : { coverKey: stored.storageKey },
      select: { id: true, avatarKey: true, coverKey: true },
    });

    // Signed URLs out, never the keys — the same rule the read path follows.
    const [avatarUrl, coverUrl] = await Promise.all([
      updated.avatarKey
        ? this.uploads.signedUrl(updated.avatarKey).then((r) => r.url)
        : Promise.resolve(null),
      updated.coverKey
        ? this.uploads.signedUrl(updated.coverKey).then((r) => r.url)
        : Promise.resolve(null),
    ]);

    // After the row points at the new object, so a failed delete leaves an
    // orphan rather than a profile pointing at nothing.
    if (previous) {
      await this.uploads.remove(previous).catch(() => undefined);
    }

    await this.cache.invalidateResource('providers', user.providerId);
    return { id: updated.id, avatarUrl, coverUrl };
  }

  @Post('service-images/:serviceId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER, UserRole.ADMIN)
  @Throttle({ default: WRITE_THROTTLE.serviceImage })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadServiceImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @UploadedFile() file: MulterFile,
  ) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, deletedAt: null },
      select: { id: true, providerId: true },
    });
    if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');
    if (
      user.role !== UserRole.ADMIN &&
      service.providerId !== user.providerId
    ) {
      throw ApiError.forbidden(
        'NOT_RESOURCE_OWNER',
        'That is not your service.',
      );
    }

    // Images only here. A PDF in a gallery is not a mistake worth allowing.
    const stored = await this.uploads.store(
      file,
      `service-images/${serviceId}`,
      IMAGE_MIMES,
    );

    const count = await this.prisma.serviceImage.count({
      where: { serviceId },
    });

    return this.prisma.serviceImage.create({
      data: {
        serviceId,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        position: count,
      },
      select: { id: true, position: true, mimeType: true, createdAt: true },
    });
  }

  /**
   * Serves a file held on local disk, for the signed links that driver mints.
   *
   * Public by necessity — an <img> tag sends no Authorization header — but
   * not open: the query carries an HMAC over the key and an expiry, and
   * nothing is read without it verifying. That is the same bargain a
   * presigned S3 URL makes, which is the point: local development behaves
   * like production rather than serving a wide-open folder.
   *
   * Only reachable when the local driver is active. Under S3 the signed URL
   * points at the bucket and this route refuses everything.
   */
  @Public()
  @Get('local/file')
  async serveLocalFile(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Query('name') name: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const driver = this.uploads.localDriver;
    if (!driver) throw ApiError.notFound('NOT_FOUND');

    if (!key || !signature || !driver.verify(key, Number(expires), signature)) {
      // One message for a bad signature, a tampered key and an expired link
      // alike: distinguishing them tells someone probing which part to vary.
      throw ApiError.forbidden(
        'INVALID_SIGNATURE',
        'That link is not valid or has expired.',
      );
    }

    let body: Buffer;
    try {
      body = await driver.read(key);
    } catch {
      throw ApiError.notFound('FILE_NOT_FOUND', 'That file is not here.');
    }

    /**
     * The content type comes from the key's extension, which this application
     * generated from the file's *magic bytes* rather than from the uploaded
     * filename — so it describes what the bytes are, not what the uploader
     * claimed.
     *
     * It matters: helmet sets X-Content-Type-Options: nosniff, so serving an
     * avatar as application/octet-stream means the browser refuses to render
     * it and every profile photo is a broken image.
     *
     * Only raster images go inline. Anything else is sent as a download,
     * which is what stops a file that slipped past the type check from
     * executing in a page. SVG is not accepted at all — see file-type.ts, it
     * is a script-capable document.
     */
    const inlineType = INLINE_TYPES[extensionOf(key)];

    res.setHeader('Content-Type', inlineType ?? 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      inlineType && !name
        ? 'inline'
        : `attachment; filename="${name ?? 'download'}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Cacheable only for as long as the link itself lives, and never shared.
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(body);
  }

  /**
   * Exchanges a stored object for a short-lived URL. Authorisation happens
   * here, by resolving what the id refers to and checking the caller against
   * it, rather than by trusting an opaque key from the client.
   */
  @Get('provider-documents/:id/url')
  async signProviderDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // provider_documents is under RLS, so this read needs the caller's
    // context: without one it returned nothing and every download 404'd,
    // including the owner's. The explicit owner check below still stands,
    // because an admin can see every row.
    const doc = await this.prisma.withUser(toAuthContext(user), (tx) =>
      tx.providerDocument.findUnique({
        where: { id },
        select: {
          storageKey: true,
          originalFilename: true,
          providerId: true,
        },
      }),
    );
    if (!doc) throw ApiError.notFound('DOCUMENT_NOT_FOUND');

    if (user.role !== UserRole.ADMIN && doc.providerId !== user.providerId) {
      throw ApiError.forbidden(
        'NOT_RESOURCE_OWNER',
        'That is not your document.',
      );
    }

    return this.uploads.signedUrl(doc.storageKey, doc.originalFilename);
  }

  /** Service images are public, so this one only needs the image to exist. */
  @Get('service-images/:id/url')
  async signServiceImage(@Param('id', ParseUUIDPipe) id: string) {
    const image = await this.prisma.serviceImage.findUnique({
      where: { id },
      select: { storageKey: true },
    });
    if (!image) throw ApiError.notFound('IMAGE_NOT_FOUND');
    return this.uploads.signedUrl(image.storageKey);
  }
}

/**
 * Types safe to render in a page, keyed by the extension the magic-byte
 * detection produced. Anything not listed is served as a download.
 */
const INLINE_TYPES: Record<string, string | undefined> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

function extensionOf(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot === -1 ? '' : key.slice(dot + 1).toLowerCase();
}
