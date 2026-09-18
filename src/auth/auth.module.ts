import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ttlToSeconds } from '../config/configuration';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { EmailVerificationService } from './email-verification.service';
import { GoogleAuthService } from './google-auth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { OAuthRedirectFilter } from './filters/oauth-redirect.filter';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: ttlToSeconds(
            config.get<string>('JWT_ACCESS_TTL', '15m'),
            900,
          ),
          issuer: config.get<string>('JWT_ISSUER', 'fixitph'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordResetService,
    EmailVerificationService,
    GoogleAuthService,
    GoogleAuthGuard,
    OAuthRedirectFilter,
    JwtStrategy,
    {
      /**
       * Registered only when Google is actually configured.
       *
       * Constructing a passport OAuth strategy without a client id throws, so
       * an unconfigured deployment would fail to boot over a feature it does
       * not use. Returning null leaves the 'google' strategy unregistered and
       * GoogleAuthGuard answers the routes with a clear message instead.
       */
      provide: GoogleStrategy,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('GOOGLE_CLIENT_ID')
          ? new GoogleStrategy(config)
          : null,
    },
  ],
  exports: [AuthService, PasswordResetService],
})
export class AuthModule {}
