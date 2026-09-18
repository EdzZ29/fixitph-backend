import { Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import {
  ProviderProfileController,
  ProviderProfileService,
} from './provider-profile.controller';
import { ReviewsModule } from '../reviews/reviews.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [ReviewsModule, UploadsModule],
  // ProviderProfileController is declared first so /providers/me is matched
  // before /providers/:idOrSlug, which would otherwise swallow "me" and try
  // to look up a provider with that slug.
  controllers: [ProviderProfileController, ProvidersController],
  providers: [ProvidersService, ProviderProfileService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
