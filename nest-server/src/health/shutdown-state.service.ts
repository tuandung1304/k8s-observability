import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';

/**
 * Tracks whether the app has started shutting down, so readiness can report
 * "not ready" while in-flight requests are drained.
 */
@Injectable()
export class ShutdownStateService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownStateService.name);
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // Runs after onModuleDestroy and before the HTTP server stops accepting connections
  beforeApplicationShutdown(signal?: string): void {
    this.shuttingDown = true;
    this.logger.log(`Received ${signal ?? 'shutdown'}, draining in-flight requests`);
  }
}
