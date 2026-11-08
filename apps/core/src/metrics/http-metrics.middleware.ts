import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Histogram } from 'prom-client';

import { HTTP_REQUEST_DURATION } from './metrics.constants.js';

const IGNORED_PREFIXES = ['/health', '/metrics'];

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    @Inject(HTTP_REQUEST_DURATION) private readonly duration: Histogram<
      'method' | 'route' | 'status_code'
    >,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (IGNORED_PREFIXES.some((prefix) => req.originalUrl.startsWith(prefix))) return next();

    const end = this.duration.startTimer();
    // Nest binds middleware as an Express route, so `req.route` here is the middleware's own wildcard layer
    const middlewareRoute: unknown = req.route;
    // `finish` fires after exception filters have set the final status code
    res.once('finish', () => {
      // A matched controller replaces `req.route` with its own layer; unknown paths share one label to bound cardinality
      const route =
        req.route === middlewareRoute ? undefined : (req.route as { path?: string } | undefined);
      end({
        method: req.method,
        route: route?.path ?? 'unmatched',
        status_code: res.statusCode,
      });
    });
    next();
  }
}
