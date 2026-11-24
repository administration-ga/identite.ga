/**
 * Appareil de confiance côté app : identifiant d'installation et secret TOTP,
 * rangés dans le SecureStore sous des clés `idn.authenticator.<compte>.*`.
 *
 * La logique est ici, sans import natif : le stockage et les appels Convex sont
 * injectés, ce qui permet de la tester avec vitest (device.test.ts).
 */

/** Stockage clé / valeur minimal (SecureStore en production). */
export type AuthenticatorStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};

export type RegisterResult = { created: boolean; deviceId: string; secret: string | null };
export type RotateResult = { deviceId: string; secret: string };

export type ProvisionDeps = {
  storage: AuthenticatorStorage;
  /** Identifiant du compte (sujet OIDC) : chaque compte a son propre appareil. */
  userId: string;
  name: string;
  platform: 'ios' | 'android';
  /** Identifiant aléatoire de cette installation (généré une seule fois). */
  newInstallationId: () => string;
  register: (args: { installationId: string; name: string; platform: 'ios' | 'android' }) => Promise<RegisterResult>;
  rotate: (args: { installationId: string }) => Promise<RotateResult>;
};

export type ProvisionOutcome = 'registered' | 'rotated' | 'ready';

/** Clés SecureStore d'un compte. Caractères limités à [A-Za-z0-9._-] par SecureStore. */
export function authenticatorKeys(userId: string) {
  const account = userId.replace(/[^A-Za-z0-9]/g, '_');
  return {
    installation: `idn.authenticator.${account}.installationId`,
    secret: `idn.authenticator.${account}.secret`,
  };
}

/**
 * Enregistre l'appareil auprès du serveur si besoin, et s'assure que le secret
 * local existe.
 *
 * - Première fois : `register` crée l'appareil et renvoie le secret → `registered`.
 * - Déjà connu et secret présent sur le téléphone → `ready`, aucun secret ne circule.
 * - Déjà connu mais secret local perdu, ou `force` demandé → `rotate` renvoie un
 *   nouveau secret → `rotated`.
 *
 * Une erreur serveur (plafond d'appareils, réseau) remonte à l'appelant : rien
 * n'est écrit localement à moitié.
 */
export async function provisionAuthenticator(
  deps: ProvisionDeps,
  options: { force?: boolean } = {},
): Promise<ProvisionOutcome> {
  const keys = authenticatorKeys(deps.userId);
  let installationId = await deps.storage.getItem(keys.installation);
  if (!installationId) installationId = deps.newInstallationId();

  const registration = await deps.register({
    installationId,
    name: deps.name,
    platform: deps.platform,
  });
  // L'identifiant n'est persisté qu'une fois le serveur d'accord.
  await deps.storage.setItem(keys.installation, installationId);

  if (registration.created && registration.secret) {
    await deps.storage.setItem(keys.secret, registration.secret);
    return 'registered';
  }

  const localSecret = await deps.storage.getItem(keys.secret);
  if (localSecret && !options.force) return 'ready';

  const rotated = await deps.rotate({ installationId });
  await deps.storage.setItem(keys.secret, rotated.secret);
  return 'rotated';
}

/** Lecture locale : identifiant d'installation et secret du compte, s'ils existent. */
export async function readAuthenticatorState(
  storage: AuthenticatorStorage,
  userId: string,
): Promise<{ installationId: string | null; secret: string | null }> {
  const keys = authenticatorKeys(userId);
  return {
    installationId: await storage.getItem(keys.installation),
    secret: await storage.getItem(keys.secret),
  };
}
