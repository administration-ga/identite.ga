"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import {
  oneTimeTokenClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const SITE_URL =
  typeof window !== "undefined" ? window.location.origin : undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient({
  baseURL: SITE_URL || undefined,
  // Le client ne navigue JAMAIS de lui-même : chaque écran suit, une seule fois,
  // l'adresse que rend le fournisseur. Le module de redirection par défaut suivait
  // déjà `{ redirect: true, url }` (reprise de /oauth2/authorize, connexion), puis
  // la page naviguait une seconde fois vers le même retour : le premier passage
  // consommait le code et le `state` chez le partenaire, le second y était refusé
  // (`state_mismatch`, diaspora.ga, 24/11/2026). Voir tests/auth-client-navigation.test.ts.
  disableDefaultFetchPlugins: true,
  plugins: [
    convexClient(),
    crossDomainClient(),
    oneTimeTokenClient(),
    // Challenge 2FA à la connexion (verifyTotp / verifyBackupCode), comme le
    // mobile. Sans `onTwoFactorRedirect`, l'écran de connexion aiguille lui-même.
    twoFactorClient(),
    // Clés d'accès WebAuthn (signIn.passkey, passkey.addPasskey).
    passkeyClient(),
  ],
});
