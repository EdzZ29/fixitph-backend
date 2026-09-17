import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { validateEnv } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { MailModule } from './mail/mail.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { OwnershipGuard } from './common/guards/ownership.guard';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProvidersModule } from './providers/providers.module';
import { CategoriesModule } from './categories/categories.module';
import { ServicesModule } from './services/services.module';
import { RequestsModule } from './requests/requests.module';
import { QuotesModule } from './quotes/quotes.module';
import { BookingsModule } from './bookings/bookings.module';
import { ReviewsModule } from './reviews/reviews.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FavoritesModule } from './favorites/favorites.module';
import { ReportsModule } from './reports/reports.module';
import { DisputesModule } from './disputes/disputes.module';
import { AdminModule } from './admin/admin.module';
import { UploadsModule } from './uploads/uploads.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),

    /**
     * Named buckets so a route can pick the one that fits. The default applies
     * everywhere the ThrottlerGuard runs; `auth`, `write` and `messaging` are
     * opted into with @Throttle on the routes that need them.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: 120 },
        { name: 'auth', ttl: 900_000, limit: 20 },
        { name: 'write', ttl: 3_600_000, limit: 60 },
        { name: 'messaging', ttl: 60_000, limit: 60 },
      ],
    }),

    PrismaModule,
    CacheModule,
    MailModule,

    AuthModule,
    UsersModule,
    ProvidersModule,
    CategoriesModule,
    ServicesModule,
    RequestsModule,
    QuotesModule,
    BookingsModule,
    ReviewsModule,
    MessagesModule,
    NotificationsModule,
    FavoritesModule,
    ReportsModule,
    DisputesModule,
    AdminModule,
    UploadsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters. Throttling first so a flood is rejected before it costs a
    // database round trip, then authentication, then role checks.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },

    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Not global: applied per route with @RequireOwnership.
    OwnershipGuard,
  ],
})
export class AppModule {}
