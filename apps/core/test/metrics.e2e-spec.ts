import { Controller, Get, NotFoundException, Param, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';

@Controller('test-metrics')
class TestMetricsController {
  @Get('static')
  static() {
    return { ok: true };
  }

  @Get('items/:id')
  item(@Param('id') id: string) {
    if (id === 'missing') throw new NotFoundException();
    return { id };
  }
}

describe('Metrics (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestMetricsController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes default process metrics in the Prometheus text format', async () => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('process_cpu_seconds_total');
    expect(response.text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('records request duration by route template and final status code', async () => {
    const server = app.getHttpServer();
    await request(server).get('/test-metrics/items/1').expect(200);
    await request(server).get('/test-metrics/items/2').expect(200);
    await request(server).get('/test-metrics/items/missing').expect(404);
    await request(server).get('/test-metrics/static?page=2').expect(200);
    await request(server).get('/does-not-exist').expect(404);
    await request(server).get('/health/live').expect(200);

    const { text } = await request(server).get('/metrics').expect(200);

    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="GET",route="/test-metrics/items/:id",status_code="200"} 2',
    );
    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="GET",route="/test-metrics/items/:id",status_code="404"} 1',
    );
    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="GET",route="/test-metrics/static",status_code="200"} 1',
    );
    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="GET",route="unmatched",status_code="404"} 1',
    );
    expect(text).not.toContain('route="/health/live"');
    expect(text).not.toContain('route="/metrics"');
  });
});
