import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { ShutdownStateService } from './shutdown-state.service.js';

type HealthStatus = { status: 'ok' };

@Controller('health')
export class HealthController {
  constructor(private readonly shutdownState: ShutdownStateService) {}

  // Liveness: only answers "is the process responsive?". Never check external
  // dependencies here — a failing DB would make every Pod restart in a loop.
  @Get('live')
  live(): HealthStatus {
    return { status: 'ok' };
  }

  // Readiness: "should this instance receive traffic?". Dependency checks
  // (DB, cache...) belong here once the app has them.
  @Get('ready')
  ready(): HealthStatus {
    if (this.shutdownState.isShuttingDown) {
      throw new ServiceUnavailableException({ status: 'shutting_down' });
    }
    return { status: 'ok' };
  }
}
