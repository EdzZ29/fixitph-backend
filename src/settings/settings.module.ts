import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The public face of platform_settings. Admins read and write the full table
 * through /api/admin/settings; this route exposes only the rows flagged
 * `is_public`, because a maintenance notice has to reach someone who cannot
 * log in.
 *
 * The RLS policy on the table enforces the same split independently, so a
 * mistake here cannot leak an operational setting.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returned as a flat key/value map rather than rows: the caller wants
   * `settings['maintenance.notice']`, not a list to search through.
   *
   * Deliberately uncached. It is one small indexed read, and a stale
   * maintenance banner is the exact thing this setting exists to avoid.
   */
  async publicSettings(): Promise<Record<string, unknown>> {
    // No withUser(): an anonymous context is correct here, and the policy
    // narrows the read to public rows on its own.
    const rows = await this.prisma.platformSetting.findMany({
      where: { isPublic: true },
      select: { key: true, value: true },
      orderBy: { key: 'asc' },
    });

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get()
  list() {
    return this.settings.publicSettings();
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
