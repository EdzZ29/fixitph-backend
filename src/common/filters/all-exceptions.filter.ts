import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ApiError } from '../errors';

/**
 * Single exit point for every error, so clients only ever see one of:
 *   { success: false, message, code }
 *   { success: false, message, errors }   (validation only)
 *
 * Internal detail (SQL text, stack traces, constraint internals) is logged,
 * never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, body } = this.translate(exception);

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${status} ${body.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(
        `${req.method} ${req.originalUrl} -> ${status} ${body.code}`,
      );
    }

    res.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    body: { success: false; message: string; code: string; errors?: unknown };
  } {
    if (exception instanceof ApiError) {
      return {
        status: exception.getStatus(),
        body: {
          success: false,
          message: exception.message,
          code: exception.code,
        },
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: {
          success: false,
          message: 'Too many requests. Please wait a moment and try again.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      // The global ValidationPipe throws with a string[] of messages.
      if (
        typeof response === 'object' &&
        response !== null &&
        Array.isArray((response as { message?: unknown }).message)
      ) {
        return {
          status,
          body: {
            success: false,
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            errors: (response as { message: string[] }).message,
          },
        };
      }

      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message);

      return {
        status,
        body: { success: false, message, code: this.codeForStatus(status) },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          success: false,
          message: 'Malformed request',
          code: 'BAD_REQUEST',
        },
      };
    }

    // A database trigger or CHECK constraint rejected the write. These carry
    // the business rule text, so surfacing the reason is useful, but the raw
    // SQLSTATE and statement stay in the log.
    const raw = exception as { code?: string; message?: string };
    if (raw?.code === '42501') {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          success: false,
          message: 'That change is not permitted.',
          code: 'DB_POLICY_VIOLATION',
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        message: 'Something went wrong on our end.',
        code: 'INTERNAL_ERROR',
      },
    };
  }

  private translatePrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: { success: false; message: string; code: string };
  } {
    switch (e.code) {
      case 'P2002': {
        const target =
          (e.meta?.target as string[] | string | undefined) ?? 'field';
        const field = Array.isArray(target)
          ? target.join(', ')
          : String(target);
        return {
          status: HttpStatus.CONFLICT,
          body: {
            success: false,
            message: `That ${field} is already taken.`,
            code: 'DUPLICATE_RESOURCE',
          },
        };
      }
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            success: false,
            message: 'A referenced record does not exist.',
            code: 'FOREIGN_KEY_VIOLATION',
          },
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          body: {
            success: false,
            message: 'Not found.',
            code: 'NOT_FOUND',
          },
        };
      default:
        return {
          status: HttpStatus.BAD_REQUEST,
          body: {
            success: false,
            message: 'The database rejected that request.',
            code: 'DATABASE_ERROR',
          },
        };
    }
  }

  private codeForStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMIT_EXCEEDED',
    };
    return map[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
  }
}
