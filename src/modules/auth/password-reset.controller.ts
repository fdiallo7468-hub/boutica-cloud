import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "@thallesp/nestjs-better-auth";

@Controller()
export class PasswordResetController {
  @Public()
  @Get("reset-password")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
  getResetPasswordPage(): string {
    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Réinitialiser le mot de passe - Boutica</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #fdfdfd; color: #2b282c; font: 16px system-ui, sans-serif; }
    main { width: min(100%, 420px); padding: 28px; border: 1px solid #e5e2e3; border-radius: 14px; background: #fff; }
    h1 { margin: 0 0 8px; color: #9a050e; font-size: 24px; }
    p { color: #706c70; line-height: 1.5; }
    label { display: block; margin: 18px 0 6px; font-size: 14px; font-weight: 600; }
    input { width: 100%; min-height: 48px; padding: 10px 12px; border: 1px solid #e5e2e3; border-radius: 10px; font: inherit; }
    button { width: 100%; min-height: 48px; margin-top: 20px; border: 0; border-radius: 10px; background: #9a050e; color: #fff; font: inherit; font-weight: 700; }
    button:disabled { opacity: .65; }
    #message { min-height: 24px; margin-top: 16px; }
    #message[data-tone="error"] { color: #d92d20; }
    #message[data-tone="success"] { color: #15803d; }
    [hidden] { display: none !important; }
  </style>
  <script src="/reset-password.js" defer></script>
</head>
<body>
  <main>
    <h1>Nouveau mot de passe</h1>
    <p>Choisissez un nouveau mot de passe pour votre compte Boutica.</p>
    <form id="reset-form">
      <label for="password">Nouveau mot de passe</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
      <label for="confirm-password">Confirmer le mot de passe</label>
      <input id="confirm-password" name="confirm-password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
      <button id="submit-button" type="submit">Modifier mon mot de passe</button>
    </form>
    <p id="message" role="status" aria-live="polite"></p>
  </main>
</body>
</html>`;
  }

  @Public()
  @Get("reset-password.js")
  @Header("Content-Type", "text/javascript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  getResetPasswordScript(): string {
    return `const form = document.querySelector("#reset-form");
const password = document.querySelector("#password");
const confirmation = document.querySelector("#confirm-password");
const button = document.querySelector("#submit-button");
const message = document.querySelector("#message");
const token = new URLSearchParams(window.location.search).get("token");

function showMessage(text, tone) {
  message.textContent = text;
  message.dataset.tone = tone;
}

if (!token) {
  form.hidden = true;
  showMessage("Ce lien est incomplet. Demandez un nouveau lien de réinitialisation.", "error");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (password.value !== confirmation.value) {
    showMessage("Les mots de passe ne correspondent pas.", "error");
    return;
  }

  button.disabled = true;
  showMessage("Modification en cours…", "");
  try {
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ newPassword: password.value, token }),
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(typeof data?.message === "string" ? data.message : "Ce lien est expiré ou invalide. Demandez-en un nouveau.");
    }

    form.hidden = true;
    showMessage("Votre mot de passe a été modifié. Vous pouvez retourner dans l’application et vous connecter.", "success");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "La modification a échoué. Réessayez.", "error");
    button.disabled = false;
  }
});`;
  }
}
