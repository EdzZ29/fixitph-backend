import type { UserRole } from '@prisma/client';
import type { AuthContext } from '../prisma/prisma.service';

/** What the access token proves about the caller. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  /** Present only when this user has a provider profile. */
  providerId: string | null;
  sessionId: string;
}

export function toAuthContext(
  user: AuthenticatedUser | undefined | null,
): AuthContext {
  return user
    ? { userId: user.id, role: user.role }
    : { userId: null, role: null };
}
