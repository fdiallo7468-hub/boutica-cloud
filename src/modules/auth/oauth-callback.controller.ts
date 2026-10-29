import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { Public } from "@thallesp/nestjs-better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { auth } from "../../auth/auth";
import { DesktopAuthService } from "./desktop-auth.service";

@Controller("api/v1/auth")
export class OAuthCallbackController {
  constructor(private readonly desktopAuthService: DesktopAuthService) {}

  /**
   * Endpoint de retour après authentification OAuth (Google / Apple).
   * Gère la transition sécurisée vers l'application Desktop (loopback RFC 8252)
   * ou vers l'interface Web.
   */
  @Public()
  @Get("callback")
  async handleOAuthCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("desktopPort") desktopPort?: string,
    @Query("desktopNonce") desktopNonce?: string,
  ) {
    let session: any = null;
    try {
      session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
    } catch (err) {
      console.error("[OAuthCallback] Erreur lors de la récupération de la session :", err);
    }

    // 1. Si aucune session n'est active (échec OAuth ou cookies rejetés)
    if (!session || !session.session?.token) {
      res.status(HttpStatus.UNAUTHORIZED).send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Boutica — Authentification échouée</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background-color: #0f172a;
              color: #f8fafc;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              padding: 20px;
            }
            .card {
              background: #1e293b;
              border: 1px solid #334155;
              border-radius: 12px;
              max-width: 440px;
              width: 100%;
              padding: 32px 28px;
              text-align: center;
              box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4);
            }
            .icon {
              width: 56px;
              height: 56px;
              border-radius: 50%;
              background: #450a0a;
              color: #ef4444;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0 auto 20px auto;
              font-size: 28px;
              font-weight: bold;
            }
            h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; color: #f8fafc; }
            p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 24px; }
            .btn {
              display: inline-block;
              background: #2563eb;
              color: #ffffff;
              font-weight: 500;
              font-size: 14px;
              padding: 10px 20px;
              border-radius: 6px;
              text-decoration: none;
              transition: background 0.15s ease;
            }
            .btn:hover { background: #1d4ed8; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✕</div>
            <h1>Connexion non autorisée</h1>
            <p>La session d'authentification n'a pas pu être validée. Veuillez réessayer depuis votre application Boutica.</p>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // 2. Flux Desktop : un port local et un nonce anti-CSRF sont fournis
    if (desktopPort && desktopNonce) {
      const port = parseInt(desktopPort, 10);
      const isPortValid = !isNaN(port) && port >= 1024 && port <= 65535;
      const isNonceValid = typeof desktopNonce === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(desktopNonce);

      if (!isPortValid || !isNonceValid) {
        throw new BadRequestException("Paramètres de redirection Desktop invalides ou suspects");
      }

      // Génération du code d'échange éphémère (60s)
      const exchangeCode = this.desktopAuthService.createExchangeCode(
        session.session.token,
        session.user,
      );

      const loopbackUrl = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(
        exchangeCode,
      )}&state=${encodeURIComponent(desktopNonce)}`;

      res.status(HttpStatus.OK).send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Boutica — Authentification réussie</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background-color: #0f172a;
              color: #f8fafc;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              padding: 20px;
            }
            .card {
              background: #1e293b;
              border: 1px solid #334155;
              border-radius: 12px;
              max-width: 440px;
              width: 100%;
              padding: 32px 28px;
              text-align: center;
              box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4);
            }
            .icon {
              width: 56px;
              height: 56px;
              border-radius: 50%;
              background: #064e3b;
              color: #10b981;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0 auto 20px auto;
              font-size: 28px;
              font-weight: bold;
            }
            h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; color: #f8fafc; }
            p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 24px; }
            .btn {
              display: inline-block;
              background: #2563eb;
              color: #ffffff;
              font-weight: 500;
              font-size: 14px;
              padding: 10px 20px;
              border-radius: 6px;
              text-decoration: none;
              cursor: pointer;
              transition: background 0.15s ease;
            }
            .btn:hover { background: #1d4ed8; }
            .hint { font-size: 12px; color: #64748b; margin-top: 16px; }
          </style>
          <script>
            // Redirection automatique vers le client local Boutica Desktop
            const targetUrl = ${JSON.stringify(loopbackUrl)};
            try {
              window.location.replace(targetUrl);
            } catch (e) {
              window.location.href = targetUrl;
            }
          </script>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h1>Connexion réussie !</h1>
            <p>Votre compte a été authentifié avec succès. Vous allez être redirigé vers Boutica Desktop.</p>
            <a href="${loopbackUrl}" class="btn">Ouvrir Boutica Desktop</a>
            <div class="hint">Vous pouvez fermer cet onglet une fois l'application ouverte.</div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // 3. Flux Web standard (pas de port Desktop)
    const destination = session.user?.businessId ? "/" : "/onboarding";
    res.redirect(destination);
  }

  /**
   * Échange sécurisé du code éphémère à usage unique contre le jeton de session.
   * Appelé directement en HTTPS par le processus principal de Boutica Desktop.
   */
  @Public()
  @Post("desktop-exchange")
  @HttpCode(HttpStatus.OK)
  async exchangeDesktopCode(@Body() body: { code?: string }) {
    if (!body || !body.code || typeof body.code !== "string") {
      throw new BadRequestException("Le paramètre 'code' est obligatoire");
    }

    const { sessionToken, user } = this.desktopAuthService.consumeExchangeCode(body.code);

    return {
      ok: true,
      sessionToken,
      user,
    };
  }
}
