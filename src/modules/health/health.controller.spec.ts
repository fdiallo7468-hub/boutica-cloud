import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/database/database';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const db = {
    db: {
      execute: jest.fn(),
    },
  } as unknown as DatabaseService;

  let controller: HealthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new HealthController(db);
  });

  it('returns healthy only when PostgreSQL responds', async () => {
    (db.db.execute as jest.Mock).mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await controller.check();

    expect(db.db.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(result.database).toBe('connected');
  });

  it('returns HTTP 503 when PostgreSQL is unavailable', async () => {
    (db.db.execute as jest.Mock).mockRejectedValue(new Error('database unavailable'));

    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.db.execute).toHaveBeenCalledTimes(1);
  });
});
