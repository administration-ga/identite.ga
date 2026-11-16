import { describe, expect, it } from 'vitest';
import {
  clientInitial,
  formatAgo,
  formatWhen,
  historyStatusLabel,
  isOpenRequest,
  kindLabel,
  maskAccount,
  outcomeView,
} from './confirmation';

describe('kindLabel', () => {
  it('décrit ce qui est demandé selon le type de demande', () => {
    expect(kindLabel('enroll')).toBe('activer la confirmation des connexions');
    expect(kindLabel('login')).toBe('se connecter à ton espace agent');
    expect(kindLabel('sensitive', 'signer une attestation')).toBe('signer une attestation');
    expect(kindLabel('sensitive', '   ')).toBe('une action sensible');
    expect(kindLabel('sensitive', null)).toBe('une action sensible');
  });
});

describe('maskAccount', () => {
  it('ne montre que la partie avant l’arobase', () => {
    expect(maskAccount('clarisse.mba@idn.ga')).toBe('clarisse.mba@…');
    expect(maskAccount(null)).toBe('Ton compte');
    expect(maskAccount('sans-arobase')).toBe('sans-arobase');
  });
});

describe('formatWhen et formatAgo', () => {
  const day = new Date(2026, 10, 16, 14, 32).getTime();

  it('écrit « Aujourd’hui » le jour même, la date sinon', () => {
    expect(formatWhen(day, new Date(2026, 10, 16, 20, 0).getTime())).toBe('Aujourd’hui, 14:32');
    expect(formatWhen(day, new Date(2026, 10, 17, 9, 0).getTime())).toBe('16/11, 14:32');
  });

  it('exprime l’ancienneté en termes simples', () => {
    expect(formatAgo(day, day + 20_000)).toBe('à l’instant');
    expect(formatAgo(day, day + 5 * 60_000)).toBe('il y a 5 min');
    expect(formatAgo(day, day + 3 * 3_600_000)).toBe('il y a 3 h');
  });
});

describe('isOpenRequest', () => {
  it('est ouverte seulement si en attente et non échue', () => {
    expect(isOpenRequest({ status: 'pending', expiresAt: 2000 }, 1000)).toBe(true);
    expect(isOpenRequest({ status: 'pending', expiresAt: 1000 }, 1000)).toBe(false);
    expect(isOpenRequest({ status: 'approved', expiresAt: 2000 }, 1000)).toBe(false);
  });
});

describe('outcomeView', () => {
  const clientName = 'Diplomate.ga';

  it('présente une confirmation de liaison comme « C’est prêt »', () => {
    expect(outcomeView('approved', { clientName, kind: 'enroll' })).toMatchObject({
      tone: 'ok',
      title: 'C’est prêt',
      text: 'Diplomate.ga pourra te demander de confirmer tes connexions.',
    });
  });

  it('présente une connexion confirmée comme dans la maquette', () => {
    expect(outcomeView('approved', { clientName, kind: 'login' })).toMatchObject({
      title: 'Connexion confirmée',
      text: 'Tu peux revenir sur ton ordinateur.',
    });
  });

  it('couvre chaque statut terminal', () => {
    expect(outcomeView('wrong_number', { clientName, kind: 'login' }).title).toBe('Mauvais nombre');
    expect(outcomeView('denied', { clientName, kind: 'login' }).tone).toBe('denied');
    expect(outcomeView('expired', { clientName, kind: 'login' }).title).toBe('Demande expirée');
    expect(outcomeView('cancelled', { clientName, kind: 'login' }).text).toBe('Diplomate.ga a annulé cette demande.');
  });
});

describe('historyStatusLabel et clientInitial', () => {
  it('libelle chaque statut de l’historique', () => {
    expect(historyStatusLabel('approved')).toBe('Confirmée');
    expect(historyStatusLabel('denied')).toBe('Refusée par toi');
    expect(historyStatusLabel('pending')).toBe('En attente');
  });

  it('prend l’initiale du nom, ou un point d’interrogation à défaut', () => {
    expect(clientInitial(' diplomate ')).toBe('D');
    expect(clientInitial('')).toBe('?');
  });
});
