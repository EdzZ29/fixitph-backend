import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every deliberate failure in the API is an ApiError, so the response `code`
 * is a value the frontend can switch on rather than a translated message.
 */
export class ApiError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(message, status);
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.BAD_REQUEST);
  }

  static unauthenticated(
    code: string,
    message = 'Authentication required.',
  ): ApiError {
    return new ApiError(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(
    code: string,
    message = 'You do not have access to that.',
  ): ApiError {
    return new ApiError(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(code: string, message = 'Not found.'): ApiError {
    return new ApiError(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.CONFLICT);
  }

  static unprocessable(code: string, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
