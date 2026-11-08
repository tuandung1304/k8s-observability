import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Registry } from 'prom-client';

import { METRICS_REGISTRY } from './metrics.constants.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  async metrics(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', this.registry.contentType);
    return this.registry.metrics();
  }
}
