import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { ShutdownStateService } from './shutdown-state.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly shutdownState: ShutdownStateService) {}

  // Liveness: only checks that this process responds, never dependencies
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: fails during shutdown so the Pod is removed from Service endpoints
  @Get('ready')
  ready() {
    if (this.shutdownState.isShuttingDown) {
      throw new ServiceUnavailableException({ status: 'shutting_down' });
    }
    return { status: 'ok' };
  }
}
