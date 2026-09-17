import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Every variable the API needs. Validated once at boot: a missing or weak
 * secret should stop the process, not surface as a 500 under load.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsOptional()
  API_PREFIX = 'api';

  /** Owner connection. Used by Prisma Migrate only. */
  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  /**
   * Runtime connection. Must be a non-owner, NOBYPASSRLS role, otherwise every
   * row level security policy is silently skipped.
   */
  @IsString()
  @MinLength(1)
  DATABASE_APP_URL!: string;

  /**
   * Empty selects the in-memory cache, which is single-process only. Set it to
   * a redis:// URL for anything beyond one developer's machine.
   */
  @IsString()
  @IsOptional()
  REDIS_URL = '';

  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters',
  })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, {
    message: 'JWT_REFRESH_SECRET must be at least 32 characters',
  })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_TTL = '15m';

  @IsString()
  @IsOptional()
  JWT_REFRESH_TTL = '30d';

  @IsString()
  @IsOptional()
  JWT_ISSUER = 'fixitph';

  /** Comma-separated allow-list. No wildcards, ever. */
  @IsString()
  @MinLength(1)
  CORS_ORIGIN!: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  LOGIN_MAX_ATTEMPTS = 5;

  @IsInt()
  @Min(1)
  @IsOptional()
  LOGIN_LOCKOUT_MINUTES = 15;

  @IsString()
  @IsOptional()
  COOKIE_DOMAIN?: string;

  @IsBooleanString()
  @IsOptional()
  COOKIE_SECURE?: string;

  // --- Mail -----------------------------------------------------------------
  /**
   * Without SMTP_HOST, emails are written to the log. That is fine locally and
   * refused in production, where a dropped reset code is a silent lockout.
   */
  @IsString()
  @IsOptional()
  SMTP_HOST = '';

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  SMTP_PORT = 587;

  @IsString()
  @IsOptional()
  SMTP_USER?: string;

  @IsString()
  @IsOptional()
  SMTP_PASSWORD?: string;

  @IsString()
  @IsOptional()
  MAIL_FROM = 'FixItPH <no-reply@fixitph.example>';

  // --- Password reset -------------------------------------------------------
  @IsInt()
  @Min(1)
  @IsOptional()
  RESET_CODE_TTL_MINUTES = 10;

  @IsInt()
  @Min(1)
  @IsOptional()
  RESET_MAX_ATTEMPTS = 3;

  @IsInt()
  @Min(1)
  @IsOptional()
  RESET_LOCKOUT_MINUTES = 15;

  // --- Object storage (S3 compatible) ---------------------------------------
  @IsString()
  @IsOptional()
  S3_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  S3_REGION = 'ap-southeast-1';

  @IsString()
  @IsOptional()
  S3_BUCKET = 'fixitph-private';

  @IsString()
  @IsOptional()
  S3_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  S3_SECRET_ACCESS_KEY?: string;

  @IsBooleanString()
  @IsOptional()
  S3_FORCE_PATH_STYLE?: string;

  @IsInt()
  @Min(30)
  @IsOptional()
  SIGNED_URL_TTL_SECONDS = 300;

  @IsInt()
  @Min(1)
  @IsOptional()
  MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
}

const INT_KEYS = new Set([
  'PORT',
  'LOGIN_MAX_ATTEMPTS',
  'LOGIN_LOCKOUT_MINUTES',
  'SIGNED_URL_TTL_SECONDS',
  'MAX_UPLOAD_BYTES',
  'SMTP_PORT',
  'RESET_CODE_TTL_MINUTES',
  'RESET_MAX_ATTEMPTS',
  'RESET_LOCKOUT_MINUTES',
]);

export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const coerced: Record<string, unknown> = { ...raw };
  for (const key of INT_KEYS) {
    if (coerced[key] !== undefined && coerced[key] !== '') {
      coerced[key] = Number(coerced[key]);
    } else {
      delete coerced[key];
    }
  }
  // Let the class defaults apply instead of overwriting them with ''.
  for (const [k, v] of Object.entries(coerced)) {
    if (v === '') delete coerced[k];
  }

  const config = plainToInstance(EnvironmentVariables, coerced, {
    enableImplicitConversion: false,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map(
        (e) =>
          `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return config;
}

export function corsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Converts a TTL like "15m" or "30d" to seconds. jsonwebtoken accepts a number
 * of seconds unambiguously, whereas its string form is a literal union type
 * that a value read from the environment can never satisfy.
 */
export function ttlToSeconds(ttl: string, fallbackSeconds: number): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return fallbackSeconds;
  const amount = Number(match[1]);
  const factor: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * (factor[match[2]] ?? 1);
}
