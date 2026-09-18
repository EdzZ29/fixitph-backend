import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { validateEnv } from './config/configuration';
import { READ_THROTTLE } from './common/throttle';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { EventsModule } from './events/events.module';
import { ChangePublishInterceptor } from './events/change-publish.interceptor';
import { MailModule } from './mail/mail.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { OwnershipGuard } from './common/guards/ownership.guard';
import { ScopedThrottlerGuard } from './common/guards/scoped-throttler.guard';

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
import { SettingsModule } from './settings/settings.module';
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
     * One bucket, tightened per route.
     *
     * This used to declare four named buckets, which reads as "a route picks
     * the one that fits" but is not how the throttler works: *every* named
     * throttler is enforced on *every* route, and @Throttle only overrides
     * that route's budget for the bucket it names. So the auth bucket's 20
     * requests per 15 minutes silently became the ceiling for the entire API
     * — a signed-in person browsing a dashboard hit it in seconds, and the
     * symptom was a 429 on an ordinary list.
     *
     * With a single bucket, the ceiling below is the general one and the
     * strict budgets in common/throttle.ts are applied where they belong,
     * with @Throttle({ default: … }). Nothing is loosened: login is still ten
     * attempts per quarter hour. It is only applied to login now, instead of
     * to everything.
     *
     * The ceiling is sized for a person rather than a request, because a
     * dashboard screen legitimately fans out to several reads — and a
     * signed-in caller is tracked individually by ScopedThrottlerGuard rather
     * than sharing with everyone behind the same address.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: READ_THROTTLE.ttl, limit: READ_THROTTLE.limit },
      ],
    }),

    PrismaModule,
    CacheModule,
    EventsModule,
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
    SettingsModule,
    UploadsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters. Throttling first so a flood is rejected before it costs a
    // database round trip, then authentication, then role checks.
    { provide: APP_GUARD, useClass: ScopedThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },

    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // After the envelope, so it only ever sees a request that succeeded.
    { provide: APP_INTERCEPTOR, useClass: ChangePublishInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Not global: applied per route with @RequireOwnership.
    OwnershipGuard,
  ],
})
export class AppModule {}
