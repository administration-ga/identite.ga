import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { provisionAuthenticator, type ProvisionOutcome, type RegisterResult, type RotateResult } from './device';
import { secureAuthenticatorStorage } from './secure-storage';

/** Identifiant aléatoire de cette installation : 16 octets en hexadécimal. */
export function newInstallationId(): string {
  return Array.from(Crypto.getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function platform(): 'ios' | 'android' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

function name(): string {
  return Device.deviceName ?? Device.modelName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Téléphone Android');
}

/**
 * Enregistre (ou réenregistre) cet appareil pour le compte donné. Les appels
 * serveur sont injectés depuis les hooks Convex du composant appelant.
 */
export function provisionThisDevice(params: {
  userId: string;
  register: (args: { installationId: string; name: string; platform: 'ios' | 'android' }) => Promise<RegisterResult>;
  rotate: (args: { installationId: string }) => Promise<RotateResult>;
  force?: boolean;
}): Promise<ProvisionOutcome> {
  return provisionAuthenticator(
    {
      storage: secureAuthenticatorStorage,
      userId: params.userId,
      name: name(),
      platform: platform(),
      newInstallationId,
      register: params.register,
      rotate: params.rotate,
    },
    { force: params.force },
  );
}
