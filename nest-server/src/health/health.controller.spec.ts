import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { HealthController } from './health.controller.js';
import { ShutdownStateService } from './shutdown-state.service.js';

describe('HealthController', () => {
  let controller: HealthController;
  let shutdownState: ShutdownStateService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [ShutdownStateService],
    }).compile();

    controller = moduleRef.get(HealthController);
    shutdownState = moduleRef.get(ShutdownStateService);
  });

  it('reports live and ready while running', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(controller.ready()).toEqual({ status: 'ok' });
  });

  it('stays live but becomes not ready once shutdown starts', () => {
    shutdownState.beforeApplicationShutdown('SIGTERM');

    expect(controller.live()).toEqual({ status: 'ok' });
    expect(() => controller.ready()).toThrow(ServiceUnavailableException);
  });
});
