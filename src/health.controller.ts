import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Cheap liveness check for `docker compose` and uptime probes. */
  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      database: 'reachable',
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  }
}
