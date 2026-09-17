import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { WRITE_THROTTLE } from '../common/throttle';
import { DocumentType, UserRole, VerificationStatus } from '@prisma/client';
import { ApiError } from '../common/errors';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
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
