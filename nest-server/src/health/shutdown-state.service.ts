import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ShutdownStateService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownStateService.name);
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beforeApplicationShutdown(signal?: string) {
    this.shuttingDown = true;
    this.logger.log(`Received ${signal ?? 'shutdown'}, draining in-flight requests`);
  }
}
