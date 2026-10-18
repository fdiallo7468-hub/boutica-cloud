import { ConfigService } from '@nestjs/config';
import { ArcjetService } from './arcjet.service';
import { ArcjetGuard } from './arcjet.guard';
import { ExecutionContext } from '@nestjs/common';

describe('Arcjet Security', () => {
  let configService: ConfigService;
  let arcjetService: ArcjetService;
  let guard: ArcjetGuard;

  beforeEach(async () => {
    configService = {
      get: jest.fn().mockReturnValue(''),
    } as unknown as ConfigService;
    arcjetService = new ArcjetService(configService as any);
    await arcjetService.onModuleInit();
    guard = new ArcjetGuard(arcjetService);
  });

  it('devrait fonctionner en mode pass-through si ARCJET_KEY est absente', async () => {
    expect(arcjetService.enabled).toBe(false);
    const decision = await arcjetService.protect({} as any);
    expect(decision.isDenied()).toBe(false);
  });

  it('devrait autoriser les requêtes vers /health sans blocage', async () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/health' }),
      }),
    } as unknown as ExecutionContext;

    const allowed = await guard.canActivate(mockContext);
    expect(allowed).toBe(true);
  });
});
