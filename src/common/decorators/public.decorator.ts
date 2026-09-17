import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of JwtAuthGuard. Authentication is the default: a route is
 * only reachable anonymously if it says so out loud.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
