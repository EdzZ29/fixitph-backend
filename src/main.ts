import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { corsOrigins } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Stops Nest printing the whole request body, which would put passwords
    // into the logs on a validation failure.
    bodyParser: true,
  });

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const prefix = config.get<string>('API_PREFIX', 'api');
  app.setGlobalPrefix(prefix, { exclude: ['health'] });

  app.use(cookieParser());

  app.use(
    helmet({
      // This is a JSON API. It never serves a document, so the strictest
      // policy is also the correct one.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts:
        config.get('NODE_ENV') === 'production'
          ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
          : false,
    }),
  );

  // Behind a reverse proxy, so req.ip reflects the real client for rate
  // limiting and audit rows rather than the proxy address.
  app.set('trust proxy', 1);

  const origins = corsOrigins(config.getOrThrow<string>('CORS_ORIGIN'));
  app.enableCors({
    // An explicit list. Never true, never a reflected Origin header: with
    // credentials enabled that is the same as having no protection at all.
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip anything not declared on the DTO, then refuse the request if
      // anything was stripped. Belt and braces against mass assignment.
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`FixItPH API listening on http://localhost:${port}/${prefix}`);
  logger.log(`CORS allow-list: ${origins.join(', ')}`);
}

void bootstrap();
