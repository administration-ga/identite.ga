import { describe, expect, it } from 'vitest';
import { formatTotpCode, hmacSha1, hotp, secondsUntilNextCode, sha1, totpAt, base32Decode } from './totp';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const text = (value: string) => new TextEncoder().encode(value);

/** Secret de la RFC 6238 (ASCII « 12345678901234567890 »), en base32. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('SHA-1', () => {
  it('reproduit les vecteurs FIPS 180-4', () => {
    expect(hex(sha1(text('')))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(text('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    // Message de deux blocs (56 octets) : exerce le rembourrage sur un second bloc.
    expect(hex(sha1(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });
});

describe('HMAC-SHA1', () => {
  it('reproduit les vecteurs RFC 2202', () => {
    expect(hex(hmacSha1(new Uint8Array(20).fill(0x0b), text('Hi There')))).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00',
    );
    expect(hex(hmacSha1(text('Jefe'), text('what do ya want for nothing?')))).toBe(
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
    );
  });

  it('hache d’abord une clé plus longue que le bloc (64 octets)', () => {
    expect(
      hex(
        hmacSha1(
          new Uint8Array(80).fill(0xaa),
          text('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });
});

describe('base32', () => {
  it('décode l’alphabet RFC 4648, casse et espaces tolérés', () => {
    expect(new TextDecoder().decode(base32Decode('mzxw 6ytb oi=='))).toBe('foobar');
  });

  it('rejette un caractère hors alphabet', () => {
    expect(() => base32Decode('MZ1W')).toThrow('BASE32_INVALID');
  });
});

describe('TOTP (RFC 6238, SHA-1, 6 chiffres)', () => {
  // Vecteurs de l'Annexe B, 6 derniers chiffres. Recalculés aussi côté serveur
  // (convex/partnerMfa/totpCore.test.ts) et avec Python (hmac/hashlib).
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('produit le code attendu à t=%i', (seconds, code) => {
    expect(totpAt(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('hotp complète les codes à 6 chiffres par des zéros à gauche', () => {
    // Compteur 0 du secret RFC : 755224 (RFC 4226, Annexe D).
    expect(hotp(RFC_SECRET, 0)).toBe('755224');
  });

  it('un même pas de 30 s donne le même code', () => {
    expect(totpAt(RFC_SECRET, 1111111110_000)).toBe(totpAt(RFC_SECRET, 1111111139_999));
  });
});

describe('affichage du compte à rebours et du code', () => {
  it('indique les secondes restantes, de 30 à 1', () => {
    expect(secondsUntilNextCode(0)).toBe(30);
    expect(secondsUntilNextCode(29_999)).toBe(1);
    expect(secondsUntilNextCode(30_000)).toBe(30);
    expect(secondsUntilNextCode(47_000)).toBe(13);
  });

  it('découpe le code en deux groupes de trois', () => {
    expect(formatTotpCode('123456')).toBe('123 456');
    expect(formatTotpCode('005924')).toBe('005 924');
  });
});
