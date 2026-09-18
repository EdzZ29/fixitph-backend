import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';

/**
 * Nest marks an @Sse() handler with this. Such a handler returns a stream of
 * frames rather than one response body, and wrapping each frame in the
 * success envelope would turn a valid event stream into a sequence of objects
 * no EventSource can read.
 */
const SSE_METADATA = 'sse';

/** Shape of every successful response. */
export interface ApiResponse<T> {
  success: true;
  data: T;
}

/**
 * Wraps controller return values in { success: true, data }. A controller that
 * already returned that shape (or set its own body) is passed through, so
 * paginated envelopes stay intact.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    if (this.reflector.get<string>(SSE_METADATA, ctx.getHandler())) {
      return next.handle() as unknown as Observable<ApiResponse<T>>;
    }

    return next.handle().pipe(
      map((data) => {
        if (
          data !== null &&
          typeof data === 'object' &&
          'success' in (data as Record<string, unknown>)
        ) {
          return data as unknown as ApiResponse<T>;
        }
        return { success: true as const, data };
      }),
    );
  }
}
