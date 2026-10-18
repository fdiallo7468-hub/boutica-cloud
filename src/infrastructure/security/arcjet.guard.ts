import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ArcjetService } from './arcjet.service';

@Injectable()
export class ArcjetGuard implements CanActivate {
  constructor(private readonly arcjetService: ArcjetService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.arcjetService.enabled) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest();

    // Toujours autoriser les checks d'infrastructure et health checks
    if (req.url === '/health' || req.url === '/health/' || req.url?.startsWith('/docs')) {
      return true;
    }

    try {
      const decision = await this.arcjetService.protect(req);

      if (decision && typeof decision.isDenied === 'function' && decision.isDenied()) {
        const reason = decision.reason;
        if (reason && typeof reason.isRateLimit === 'function' && reason.isRateLimit()) {
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              error: 'Too Many Requests',
              message: 'Taux de requêtes trop élevé. Veuillez réessayer dans quelques instants.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        } else if (reason && typeof reason.isBot === 'function' && reason.isBot()) {
          throw new HttpException(
            {
              statusCode: HttpStatus.FORBIDDEN,
              error: 'Forbidden',
              message: 'Activité automatisée non autorisée détectée par le bouclier applicatif.',
            },
            HttpStatus.FORBIDDEN,
          );
        } else {
          throw new HttpException(
            {
              statusCode: HttpStatus.FORBIDDEN,
              error: 'Forbidden',
              message: 'Requête bloquée par la politique de sécurité applicative.',
            },
            HttpStatus.FORBIDDEN,
          );
        }
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Fail-open contrôlé en cas d'erreur de communication avec le réseau externe Arcjet
      return true;
    }

    return true;
  }
}
