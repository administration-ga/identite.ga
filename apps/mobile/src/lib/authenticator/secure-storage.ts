import * as SecureStore from 'expo-secure-store';
import type { AuthenticatorStorage } from './device';

/** Stockage réel de l'appareil : le SecureStore du téléphone. */
export const secureAuthenticatorStorage: AuthenticatorStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
