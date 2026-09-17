import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';

/** Everything a database session needs to know about who is asking. */
export interface AuthContext {
  userId: string | null;
  role: UserRole | null;
}

export const ANONYMOUS: AuthContext = { userId: null, role: null };

/**
 * A Prisma client scoped to one transaction. All repository work takes this
 * type, so it is impossible to accidentally run a query outside the RLS
 * context that `withUser` establishes.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly config: ConfigService) {
    super({
      // Deliberately the *application* URL, not DATABASE_URL. The owner role
      // bypasses row level security; the app role does not.
      datasources: {
        db: { url: config.getOrThrow<string>('DATABASE_APP_URL') },
      },
      log:
        config.get('NODE_ENV') === 'development'
          ? ['warn', 'error']
          : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertLeastPrivilege();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Row level security is worthless if the API connects as the table owner or
   * as a BYPASSRLS role, because Postgres will skip every policy. That is a
   * silent, total failure, so it is checked at boot and refuses to start.
   */
  private async assertLeastPrivilege(): Promise<void> {
    const [role] = await this.$queryRaw<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `;

    if (!role) {
      throw new InternalServerErrorException(
        'Could not determine the database role',
      );
    }

    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `DATABASE_APP_URL connects as "${role.current_user}", which is a superuser or has ` +
          'BYPASSRLS. Every row level security policy would be skipped. Point ' +
          'DATABASE_APP_URL at the fixitph_app role instead.',
      );
    }

    const [owned] = await this.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND pg_get_userbyid(c.relowner) = current_user
        AND c.relname IN (
          'bookings','service_requests','quotes','messages',
          'reviews','provider_documents','admin_actions'
        )
    `;

    if (Number(owned?.count ?? 0) > 0) {
      throw new Error(
        `DATABASE_APP_URL connects as "${role.current_user}", which owns protected tables. ` +
          'Table owners bypass row level security unless the table is FORCEd. ' +
          'Run migrations as the owner and the API as fixitph_app.',
      );
    }

    const [rls] = await this.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relrowsecurity
        AND c.relname IN (
          'bookings','service_requests','quotes','messages',
          'reviews','provider_documents','admin_actions'
        )
    `;

    if (Number(rls?.count ?? 0) < 7) {
      throw new Error(
        `Row level security is enabled on only ${rls?.count ?? 0} of the 7 protected tables. ` +
          'Run `npx prisma migrate deploy` so the security migration is applied.',
      );
    }

    this.logger.log(
      `Connected as "${role.current_user}" with row level security active on 7 tables`,
    );
  }

  /**
   * Runs `fn` inside a transaction that carries the caller's identity, so the
   * policies written in the security migration can see who is asking.
   *
   * set_config(..., true) makes the settings transaction-local. That matters:
   * on a pooled connection a session-level setting would leak the previous
   * request's identity into the next one.
   */
  async withUser<T>(
    ctx: AuthContext,
    fn: (tx: Tx) => Promise<T>,
    options?: { statusChangeReason?: string },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId ?? ''}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_role', ${ctx.role ?? ''}, true)`;
        if (options?.statusChangeReason) {
          await tx.$executeRaw`SELECT set_config('app.status_change_reason', ${options.statusChangeReason}, true)`;
        }
        return fn(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /** Convenience for public, unauthenticated reads. */
  async withoutUser<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withUser(ANONYMOUS, fn);
  }
}
