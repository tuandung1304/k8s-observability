import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/health/live', '/health/ready'])('GET %s returns ok', async (path) => {
    const response = await request(app.getHttpServer()).get(path).expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
  });
});
