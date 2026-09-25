import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { ShutdownStateService } from './shutdown-state.service.js';

@Module({
  controllers: [HealthController],
  providers: [ShutdownStateService],
})
export class HealthModule {}
