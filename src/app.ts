import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import 'reflect-metadata';
import { AppModule } from './app.module';

export async function createApplication() {
  for (const key of ['API_KEY']) {
    if (!process.env[key] || process.env[key]!.length < 32) {
      throw new Error(key + ' deve conter pelo menos 32 caracteres');
    }
  }
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  const options = new DocumentBuilder()
    .setTitle('reserva-api')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')

    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, options), {
    customSiteTitle: 'reserva-api | API',
  });
  return app;
}
