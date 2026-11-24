/** Destination conservée en mémoire pendant le verrouillage / la connexion. */
export function createPushNavigation() {
  let pending: string | null = null;
  const handled = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    getSnapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive(responseId: string, url: unknown) {
      const path = pushNotificationPath(url);
      if (!path || handled.has(responseId)) return;
      handled.add(responseId);
      pending = path;
      notify();
    },
    take(fallback = '/(tabs)/home') {
      const path = pending ?? fallback;
      pending = null;
      notify();
      return path;
    },
    clear() {
      pending = null;
      notify();
    },
  };
}

export function pushNotificationPath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  // Confirmation de connexion : `/confirm?id=<demande>`. Le `id` y désigne une
  // demande, pas un message : cette route doit passer avant la règle iBoîte.
  if (url === '/confirm' || url.startsWith('/confirm?')) {
    const requestId = /[?&]id=([^&]+)/.exec(url)?.[1];
    if (!requestId) return null;
    try {
      return `/confirm?id=${encodeURIComponent(decodeURIComponent(requestId))}`;
    } catch {
      return null;
    }
  }
  const messageId = /[?&]id=([^&]+)/.exec(url)?.[1];
  if (messageId) {
    try {
      return `/iboite/email/${encodeURIComponent(decodeURIComponent(messageId))}`;
    } catch {
      return null;
    }
  }
  return url.startsWith('/') && !url.startsWith('//') ? url : null;
}

/** Les écrans publics doivent terminer leur propre parcours avant de naviguer. */
export function canOpenPush(isAuthenticated: boolean, isLoading: boolean, root: string) {
  return isAuthenticated && !isLoading && !['index', 'launcher', '(auth)'].includes(root);
}

export const pushNavigation = createPushNavigation();
