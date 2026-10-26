import { STATUS_CODES } from 'node:http';

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

/**
 * Turns every exception into an ErrorResponseBody
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const error = STATUS_CODES[statusCode] ?? 'Error';
    const body: ErrorResponseBody = {
      statusCode,
      error,
      message: error,
      requestId: req.id as string,
    };

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        body.message = response;
      } else {
        const { error, message, errors } = response as {
          error?: unknown;
          message?: unknown;
          errors?: unknown;
        };
        if (typeof error === 'string') body.error = error;
        if (typeof message === 'string') body.message = message;
        else if (Array.isArray(message)) body.message = message.join('; ');
        if (Array.isArray(errors)) body.errors = errors as ErrorResponseBody['errors'];
      }
    }

    if (statusCode >= 500) {
      // pino-http adds res.err to the request's completion log, so the error and
      // its stack are logged once, together with requestId and route.
      res.err = exception instanceof Error ? exception : new Error(String(exception));
    }

    res.status(statusCode).json(body);
  }
}
