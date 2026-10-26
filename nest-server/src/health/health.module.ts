import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';

import type { Env } from '../config/env.schema.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    TerminusModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        // Delay before shutting down after SIGTERM: the app keeps accepting and serving requests normally
        // while the load balancer removes this instance's endpoints. Set to 0 if a k8s preStop sleep hook is used.
        gracefulShutdownTimeoutMs: config.get('GRACEFUL_SHUTDOWN_TIMEOUT_MS'),
      }),
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
