/**
 * Libellés et formats de la confirmation de connexion (écrans « Est-ce bien
 * toi ? », accueil, activité). Logique pure : pas d'import React Native.
 */

export type ConfirmationKind = 'enroll' | 'login' | 'sensitive';

export type ConfirmationStatus = 'pending' | 'approved' | 'denied' | 'wrong_number' | 'cancelled' | 'expired';

/** Ce que l'écran affiche pour une demande : ce qui est demandé à l'utilisateur. */
export function kindLabel(kind: ConfirmationKind, actionLabel?: string | null): string {
  if (kind === 'enroll') return 'activer la confirmation des connexions';
  if (kind === 'login') return 'se connecter à ton espace agent';
  return actionLabel?.trim() || 'une action sensible';
}

/** « clarisse.mba@idn.ga » → « clarisse.mba@… » : l'adresse sans son domaine. */
export function maskAccount(email: string | null | undefined): string {
  if (!email) return 'Ton compte';
  const at = email.indexOf('@');
  return at > 0 ? `${email.slice(0, at)}@…` : email;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Heure locale « 14:32 ». */
export function formatClock(timeMs: number): string {
  const date = new Date(timeMs);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** « Aujourd’hui, 14:32 » le jour même, sinon « 03/11, 14:32 ». */
export function formatWhen(timeMs: number, now: number): string {
  const date = new Date(timeMs);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return `Aujourd’hui, ${formatClock(timeMs)}`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}, ${formatClock(timeMs)}`;
}

/** « à l’instant », « il y a 5 min », « il y a 2 h ». */
export function formatAgo(timeMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timeMs) / 1000));
  if (seconds < 60) return 'à l’instant';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.floor(minutes / 60)} h`;
}

/** Une demande est-elle encore répondable ? */
export function isOpenRequest(request: { status: ConfirmationStatus; expiresAt: number }, now: number): boolean {
  return request.status === 'pending' && request.expiresAt > now;
}

/** Statut affiché dans l'historique. */
export function historyStatusLabel(status: ConfirmationStatus): string {
  switch (status) {
    case 'approved':
      return 'Confirmée';
    case 'denied':
      return 'Refusée par toi';
    case 'wrong_number':
      return 'Mauvais nombre';
    case 'expired':
      return 'Expirée';
    case 'cancelled':
      return 'Annulée par le service';
    default:
      return 'En attente';
  }
}

export type OutcomeView = {
  tone: 'ok' | 'wrong' | 'denied' | 'expired' | 'cancelled';
  title: string;
  text: string;
};

/**
 * Écran de résultat. `clientName` sert dans les phrases ; `enroll` a son propre
 * ton (« C’est prêt »), comme la maquette.
 */
export function outcomeView(
  status: Exclude<ConfirmationStatus, 'pending'>,
  options: { clientName: string; kind: ConfirmationKind },
): OutcomeView {
  const { clientName, kind } = options;
  switch (status) {
    case 'approved':
      if (kind === 'enroll') {
        return {
          tone: 'ok',
          title: 'C’est prêt',
          text: `${clientName} pourra te demander de confirmer tes connexions.`,
        };
      }
      return { tone: 'ok', title: 'Connexion confirmée', text: 'Tu peux revenir sur ton ordinateur.' };
    case 'wrong_number':
      return {
        tone: 'wrong',
        title: 'Mauvais nombre',
        text: `Par sécurité, cette demande est annulée. Si c’était bien toi, relance la connexion sur ${clientName}.`,
      };
    case 'denied':
      return {
        tone: 'denied',
        title: 'Connexion bloquée',
        text: 'Personne n’a pu entrer. Si tu ne reconnais pas cette demande, sécurise ton compte.',
      };
    case 'expired':
      return {
        tone: 'expired',
        title: 'Demande expirée',
        text: `Cette demande n’est plus valable. Relance la connexion sur ${clientName} pour en recevoir une nouvelle.`,
      };
    case 'cancelled':
      return { tone: 'cancelled', title: 'Demande annulée', text: `${clientName} a annulé cette demande.` };
  }
}

/** Initiale du service, pour la tuile quand l'icône du partenaire manque. */
export function clientInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}
