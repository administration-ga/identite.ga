import { describe, expect, it } from 'vitest';
import { canOpenPush, createPushNavigation, pushNotificationPath } from './push-navigation';

describe('ouverture des notifications après authentification', () => {
  it('garde le mail pendant le lancement, le verrou Face ID/PIN et la connexion', () => {
    const navigation = createPushNavigation();
    navigation.receive('mail-1', '/iboite?folder=inbox&id=M1');
    for (const root of ['index', 'launcher', '(auth)']) {
      expect(canOpenPush(true, false, root)).toBe(false);
      expect(navigation.getSnapshot()).toBe('/iboite/email/M1');
    }
    // Une annulation Face ID / un PIN erroné ne consomme rien.
    expect(navigation.getSnapshot()).toBe('/iboite/email/M1');
    // La réussite du Face ID, du PIN ou du challenge 2FA ouvre le mail une fois.
    expect(navigation.take()).toBe('/iboite/email/M1');
    expect(navigation.take()).toBe('/(tabs)/home');
  });

  it('attend aussi la restauration de la session sur un écran privé', () => {
    expect(canOpenPush(false, true, '(tabs)')).toBe(false);
    expect(canOpenPush(false, false, '(tabs)')).toBe(false);
    expect(canOpenPush(true, true, '(tabs)')).toBe(false);
    expect(canOpenPush(true, false, '(tabs)')).toBe(true);
  });

  it('ignore le doublon entre le listener et la réponse de démarrage, même après ouverture', () => {
    const navigation = createPushNavigation();
    navigation.receive('mail-1', '/iboite?id=M1');
    expect(navigation.take()).toBe('/iboite/email/M1');
    navigation.receive('mail-1', '/iboite?id=M1');
    expect(navigation.getSnapshot()).toBeNull();
    navigation.receive('mail-2', '/iboite?id=M2');
    navigation.receive('mail-1', '/iboite?id=M1');
    expect(navigation.take()).toBe('/iboite/email/M2');
  });

  it('privilégie la dernière notification et efface la destination au changement de compte', () => {
    const navigation = createPushNavigation();
    navigation.receive('mail-1', '/iboite?id=M1');
    navigation.receive('mail-2', '/iboite?id=M2');
    expect(navigation.take()).toBe('/iboite/email/M2');
    navigation.receive('mail-3', '/iboite?id=M3');
    navigation.clear();
    expect(navigation.take()).toBe('/(tabs)/home');
  });

  it('conserve la destination à travers la proposition biométrique', () => {
    const navigation = createPushNavigation();
    navigation.receive('mail-1', '/iboite?id=M1');
    // login laisse la destination en attente ; bio l’utilise après activer / plus tard.
    expect(navigation.getSnapshot()).toBe('/iboite/email/M1');
    expect(navigation.take('/(tabs)/home')).toBe('/iboite/email/M1');
  });
});

describe('pushNotificationPath', () => {
  it('gère les mails et les autres destinations internes', () => {
    expect(pushNotificationPath('/iboite?id=M%201')).toBe('/iboite/email/M%201');
    expect(pushNotificationPath('/notifications')).toBe('/notifications');
    expect(pushNotificationPath('/settings/sessions')).toBe('/settings/sessions');
  });

  it('ignore les données absentes, externes ou mal encodées', () => {
    for (const url of [undefined, null, {}, 'https://example.com', '//example.com', '/iboite?id=%ZZ']) {
      expect(pushNotificationPath(url)).toBeNull();
    }
  });
});
