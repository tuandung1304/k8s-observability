import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';

import type { Env } from '../config/env.schema.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

/** Reuse the caller's request id (from a gateway or upstream service) when it is safe, otherwise generate one. */
function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

function withRoute(req: IncomingMessage, val: object): object {
  const route = (req as IncomingMessage & { route?: { path?: string } }).route?.path;
  return route ? { ...val, route } : val;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const isDev = config.get('NODE_ENV', { infer: true }) === 'development';

        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true, ignore: 'pid,hostname' } }
              : undefined,
            base: { service: config.get('SERVICE_NAME', { infer: true }) },
            timestamp: stdTimeFunctions.isoTime,
            formatters: { level: (label) => ({ level: label }) },
            messageKey: 'message',
            errorKey: 'error',
            genReqId,
            customProps: (req) => ({ requestId: req.id }),
            customLogLevel: (_req, res, err) => {
              if (err || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },
            customSuccessObject: (req, _res, val) => withRoute(req, val),
            customErrorObject: (req, _res, _err, val) => withRoute(req, val),
            autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
            serializers: {
              req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
