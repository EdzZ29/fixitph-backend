import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

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
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
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
