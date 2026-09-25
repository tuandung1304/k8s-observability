import type { Server } from 'node:http';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Listen for SIGTERM/SIGINT and run the lifecycle hooks (onModuleDestroy,
  // beforeApplicationShutdown, onApplicationShutdown) before exiting.
  // useProcessExit: exit explicitly once cleanup is done instead of re-raising
  // the signal — as PID 1 in a container, a re-raised SIGTERM would be ignored.
  app.enableShutdownHooks([], { useProcessExit: true });

  // Keep idle keep-alive connections open longer than the upstream proxy
  // (ingress-nginx / cloud LB, typically 60s), otherwise the proxy may reuse a
  // socket Node has just closed and return a 502.
  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
