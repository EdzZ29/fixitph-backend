import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ChangeFeedService } from './change-feed.service';
import { EventsController } from './events.controller';

/**
 * Global, because almost every module that writes something wants to say so,
 * and threading an import through all of them would add noise without adding
 * anything. ChangeFeedService has no dependencies of its own, so there is no
 * cycle to be had.
 */
@Global()
@Module({
  imports: [
    /**
     * Its own registration rather than AuthModule's, because a ticket is not
     * an access token: same secret and issuer, so one key rotation covers
     * both, but it is minted here with its own lifetime and its own type.
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { issuer: config.get<string>('JWT_ISSUER', 'fixitph') },
      }),
    }),
  ],
  controllers: [EventsController],
  providers: [ChangeFeedService],
  exports: [ChangeFeedService],
})
export class EventsModule {}
