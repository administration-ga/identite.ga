import { describe, expect, it, vi } from 'vitest';
import {
  authenticatorKeys,
  provisionAuthenticator,
  readAuthenticatorState,
  type AuthenticatorStorage,
  type ProvisionDeps,
  type RegisterResult,
} from './device';

/** SecureStore en mémoire, pour tester sans module natif. */
function memoryStorage(initial: Record<string, string> = {}): AuthenticatorStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    deleteItem: async (key) => void data.delete(key),
  };
}

function deps(overrides: Partial<ProvisionDeps> & { storage: AuthenticatorStorage }): ProvisionDeps {
  return {
    userId: 'user_1',
    name: 'iPhone de test',
    platform: 'ios',
    newInstallationId: () => 'install-generated-0001',
    register: vi.fn(async (): Promise<RegisterResult> => ({ created: true, deviceId: 'dev_1', secret: 'SECRETAAAA' })),
    rotate: vi.fn(async () => ({ deviceId: 'dev_1', secret: 'ROTATEDBBBB' })),
    ...overrides,
  };
}

describe('clés SecureStore', () => {
  it('préfixent par idn.authenticator. et n’utilisent que des caractères autorisés', () => {
    const keys = authenticatorKeys('kVb3-x@idn.ga');
    expect(keys.installation).toBe('idn.authenticator.kVb3_x_idn_ga.installationId');
    expect(keys.secret).toBe('idn.authenticator.kVb3_x_idn_ga.secret');
    expect(keys.secret).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('provisionAuthenticator', () => {
  it('première installation : crée l’appareil, garde l’identifiant et le secret', async () => {
    const storage = memoryStorage();
    const d = deps({ storage });
    expect(await provisionAuthenticator(d)).toBe('registered');
    const keys = authenticatorKeys('user_1');
    expect(storage.data.get(keys.installation)).toBe('install-generated-0001');
    expect(storage.data.get(keys.secret)).toBe('SECRETAAAA');
    expect(d.rotate).not.toHaveBeenCalled();
  });

  it('appareil déjà connu avec son secret : prêt, sans rotation', async () => {
    const keys = authenticatorKeys('user_1');
    const storage = memoryStorage({
      [keys.installation]: 'install-known-0001',
      [keys.secret]: 'LOCALSECRET',
    });
    const d = deps({
      storage,
      register: vi.fn(async () => ({ created: false, deviceId: 'dev_1', secret: null })),
    });
    expect(await provisionAuthenticator(d)).toBe('ready');
    expect(d.register).toHaveBeenCalledWith({ installationId: 'install-known-0001', name: 'iPhone de test', platform: 'ios' });
    expect(d.rotate).not.toHaveBeenCalled();
    expect(storage.data.get(keys.secret)).toBe('LOCALSECRET');
  });

  it('secret local perdu : régénère un secret côté serveur', async () => {
    const keys = authenticatorKeys('user_1');
    const storage = memoryStorage({ [keys.installation]: 'install-known-0001' });
    const d = deps({
      storage,
      register: vi.fn(async () => ({ created: false, deviceId: 'dev_1', secret: null })),
    });
    expect(await provisionAuthenticator(d)).toBe('rotated');
    expect(d.rotate).toHaveBeenCalledWith({ installationId: 'install-known-0001' });
    expect(storage.data.get(keys.secret)).toBe('ROTATEDBBBB');
  });

  it('« réenregistrer » (force) régénère le secret même s’il existe', async () => {
    const keys = authenticatorKeys('user_1');
    const storage = memoryStorage({
      [keys.installation]: 'install-known-0001',
      [keys.secret]: 'OLDSECRET',
    });
    const d = deps({
      storage,
      register: vi.fn(async () => ({ created: false, deviceId: 'dev_1', secret: null })),
    });
    expect(await provisionAuthenticator(d, { force: true })).toBe('rotated');
    expect(storage.data.get(keys.secret)).toBe('ROTATEDBBBB');
  });

  it('appareil révoqué côté serveur : un nouvel enregistrement remplace le secret', async () => {
    const keys = authenticatorKeys('user_1');
    const storage = memoryStorage({
      [keys.installation]: 'install-known-0001',
      [keys.secret]: 'OLDSECRET',
    });
    const d = deps({ storage });
    expect(await provisionAuthenticator(d)).toBe('registered');
    expect(storage.data.get(keys.secret)).toBe('SECRETAAAA');
    expect(d.rotate).not.toHaveBeenCalled();
  });

  it('une erreur serveur ne laisse rien d’écrit localement', async () => {
    const storage = memoryStorage();
    const d = deps({
      storage,
      register: vi.fn(async () => {
        throw new Error('Au plus 10 appareils de confiance.');
      }),
    });
    await expect(provisionAuthenticator(d)).rejects.toThrow('Au plus 10');
    expect(storage.data.size).toBe(0);
  });

  it('chaque compte a son propre appareil sur le même téléphone', async () => {
    const storage = memoryStorage();
    await provisionAuthenticator(deps({ storage, userId: 'user_1' }));
    await provisionAuthenticator(
      deps({ storage, userId: 'user_2', newInstallationId: () => 'install-generated-0002' }),
    );
    expect(await readAuthenticatorState(storage, 'user_1')).toEqual({
      installationId: 'install-generated-0001',
      secret: 'SECRETAAAA',
    });
    expect(await readAuthenticatorState(storage, 'user_2')).toEqual({
      installationId: 'install-generated-0002',
      secret: 'SECRETAAAA',
    });
  });
});

describe('readAuthenticatorState', () => {
  it('renvoie null pour un compte jamais provisionné', async () => {
    expect(await readAuthenticatorState(memoryStorage(), 'nobody')).toEqual({
      installationId: null,
      secret: null,
    });
  });
});
