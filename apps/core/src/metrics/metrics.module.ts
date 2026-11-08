import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { HTTP_REQUEST_DURATION, METRICS_REGISTRY } from './metrics.constants.js';
import { MetricsController } from './metrics.controller.js';

@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_REGISTRY,
      useFactory: () => {
        const registry = new Registry();
        // Process metrics: CPU, memory, event loop lag, GC, active handles...
        collectDefaultMetrics({ register: registry });
        return registry;
      },
    },
    {
      provide: HTTP_REQUEST_DURATION,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) =>
        new Histogram({
          name: 'http_server_request_duration_seconds',
          help: 'Duration of HTTP server requests',
          labelNames: ['method', 'route', 'status_code'],
          buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
          registers: [registry],
        }),
    },
  ],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*path}');
  }
}
