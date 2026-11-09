import { ConfigService } from '@nestjs/config';
import { ArcjetService } from './arcjet.service';
import { ArcjetGuard } from './arcjet.guard';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';

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

  it('refuses to start in production when ARCJET_KEY is missing', async () => {
    const productionConfig = {
      get: jest.fn((key: string) => key === 'NODE_ENV' ? 'production' : ''),
    };
    const productionService = new ArcjetService(productionConfig as any);
    await expect(productionService.onModuleInit()).rejects.toThrow('ARCJET_KEY is required in production');
  });

  it('fails closed in production when Arcjet returns an error decision', async () => {
    const protectedService = {
      enabled: true,
      production: true,
      protect: jest.fn().mockResolvedValue({
        isErrored: () => true,
        isDenied: () => false,
      }),
    };
    const protectedGuard = new ArcjetGuard(protectedService as any);
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/api/v1/products' }),
      }),
    } as unknown as ExecutionContext;

    await expect(protectedGuard.canActivate(mockContext)).rejects.toThrow(ServiceUnavailableException);
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
