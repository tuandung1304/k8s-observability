import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';

import { AppModule } from '../src/app.module.js';
import { createZodDto } from '../src/common/zod/index.js';

class CreateItemDto extends createZodDto(z.object({ name: z.string().min(1) })) {}

@Controller('test-errors')
class TestErrorsController {
  @Get('not-found')
  notFound() {
    throw new NotFoundException('Item not found');
  }

  @Get('unauthorized')
  unauthorized() {
    throw new UnauthorizedException();
  }

  @Get('too-many-requests')
  tooManyRequests() {
    throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
  }

  @Get('bad-gateway')
  badGateway() {
    throw new BadGatewayException();
  }

  @Get('service-unavailable')
  serviceUnavailable() {
    throw new ServiceUnavailableException('Under maintenance');
  }

  @Get('custom-error')
  customError() {
    throw new UnprocessableEntityException({ message: 'Invalid state', error: 'ValidationError' });
  }

  @Get('description')
  description() {
    throw new BadRequestException('Invalid state', { description: 'InvalidState' });
  }

  @Get('unexpected')
  unexpected() {
    throw new Error('database password leaked here');
  }

  @Post('validate')
  validate(@Body() dto: CreateItemDto) {
    return dto;
  }
}

describe('Error responses (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestErrorsController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('formats HttpExceptions and echoes the request id', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-errors/not-found')
      .set('x-request-id', 'req-123')
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Item not found',
      requestId: 'req-123',
    });
  });

  it('formats unknown routes', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist').expect(404);

    expect(response.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('includes validation issues', async () => {
    const response = await request(app.getHttpServer())
      .post('/test-errors/validate')
      .send({ name: '' })
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      errors: [{ path: 'name', message: expect.any(String) }],
    });
  });

  it.each([
    ['/test-errors/unauthorized', 401, 'Unauthorized', 'Unauthorized'],
    ['/test-errors/too-many-requests', 429, 'Too Many Requests', 'Rate limit exceeded'],
    ['/test-errors/bad-gateway', 502, 'Bad Gateway', 'Bad Gateway'],
    ['/test-errors/service-unavailable', 503, 'Service Unavailable', 'Under maintenance'],
    ['/test-errors/custom-error', 422, 'ValidationError', 'Invalid state'],
    ['/test-errors/description', 400, 'InvalidState', 'Invalid state'],
  ])('formats %s', async (path, statusCode, error, message) => {
    const response = await request(app.getHttpServer()).get(path).expect(statusCode);

    expect(response.body).toEqual({
      statusCode,
      error,
      message,
      requestId: response.headers['x-request-id'],
    });
  });

  it('hides the details of unexpected errors', async () => {
    const response = await request(app.getHttpServer()).get('/test-errors/unexpected').expect(500);

    expect(response.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
      requestId: expect.any(String),
    });
  });
});
