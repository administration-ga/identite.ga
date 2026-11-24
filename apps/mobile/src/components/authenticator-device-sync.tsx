import React from 'react';
import { Platform } from 'react-native';
import { useConvexAuth, useMutation } from 'convex/react';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { provisionThisDevice } from '@/lib/authenticator/this-device';

/** Comptes déjà enregistrés pendant cette session de l'app. */
const provisioned = new Set<string>();

/**
 * Enregistre silencieusement cet appareil de confiance quand un compte est
 * connecté. Ne rend rien et ne bloque rien : en cas d'échec, la section
 * Sécurité propose de réessayer, et la prochaine ouverture recommence.
 */
export function AuthenticatorDeviceSync() {
  const { isAuthenticated } = useConvexAuth();
  const register = useMutation(api.partnerMfa.devices.registerDevice);
  const rotate = useMutation(api.partnerMfa.devices.rotateDevice);

  React.useEffect(() => {
    if (!isAuthenticated || Platform.OS === 'web') return;
    let active = true;
    void (async () => {
      const session = await authClient.getSession();
      const userId = session?.data?.user?.id as string | undefined;
      if (!active || !userId || provisioned.has(userId)) return;
      provisioned.add(userId);
      try {
        await provisionThisDevice({ userId, register, rotate });
      } catch (error) {
        provisioned.delete(userId);
        if (__DEV__) console.warn('[confirmation] appareil non enregistré', error);
      }
    })();
    return () => {
      active = false;
    };
  }, [isAuthenticated, register, rotate]);

  return null;
}
