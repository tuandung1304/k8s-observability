import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  /** Liveness: the process is up and serving requests. Must not depend on external services. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** Readiness: the service can handle traffic. Add indicators for its dependencies (database, cache, ...). */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([]);
  }
}
