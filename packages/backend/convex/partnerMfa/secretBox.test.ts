import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openDeviceSecret, sealDeviceSecret } from "./secretBox"

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
const OTHER_HEX = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"

const saved = {
  authenticator: process.env.IDN_AUTHENTICATOR_KEY,
  webhooks: process.env.WEBHOOK_SECRETS_KEY,
}

beforeEach(() => {
  delete process.env.IDN_AUTHENTICATOR_KEY
  delete process.env.WEBHOOK_SECRETS_KEY
})

afterEach(() => {
  restore("IDN_AUTHENTICATOR_KEY", saved.authenticator)
  restore("WEBHOOK_SECRETS_KEY", saved.webhooks)
})

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe("secretBox (secrets TOTP chiffrés au repos)", () => {
  it("chiffre puis déchiffre à l'identique avec IDN_AUTHENTICATOR_KEY", async () => {
    process.env.IDN_AUTHENTICATOR_KEY = KEY_HEX
    const sealed = await sealDeviceSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    expect(sealed.ciphertext).not.toContain("GEZDGNBV")
    expect(await openDeviceSecret(sealed)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
  })

  it("utilise un IV différent à chaque chiffrement", async () => {
    process.env.IDN_AUTHENTICATOR_KEY = KEY_HEX
    const first = await sealDeviceSecret("SECRET")
    const second = await sealDeviceSecret("SECRET")
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it("refuse un chiffré altéré", async () => {
    process.env.IDN_AUTHENTICATOR_KEY = KEY_HEX
    const sealed = await sealDeviceSecret("SECRET")
    const flipped = sealed.ciphertext.startsWith("A")
      ? `B${sealed.ciphertext.slice(1)}`
      : `A${sealed.ciphertext.slice(1)}`
    await expect(openDeviceSecret({ ...sealed, ciphertext: flipped })).rejects.toThrow()
  })

  it("refuse un déchiffrement avec une autre clé", async () => {
    process.env.IDN_AUTHENTICATOR_KEY = KEY_HEX
    const sealed = await sealDeviceSecret("SECRET")
    process.env.IDN_AUTHENTICATOR_KEY = OTHER_HEX
    await expect(openDeviceSecret(sealed)).rejects.toThrow()
  })

  it("se rabat sur WEBHOOK_SECRETS_KEY si IDN_AUTHENTICATOR_KEY est absente", async () => {
    process.env.WEBHOOK_SECRETS_KEY = KEY_HEX
    const sealed = await sealDeviceSecret("SECRET")
    expect(await openDeviceSecret(sealed)).toBe("SECRET")
  })

  it("échoue explicitement sans clé", async () => {
    await expect(sealDeviceSecret("SECRET")).rejects.toThrow("IDN_AUTHENTICATOR_KEY_MISSING")
  })

  it("rejette une clé de mauvaise taille", async () => {
    process.env.IDN_AUTHENTICATOR_KEY = "abcd"
    await expect(sealDeviceSecret("SECRET")).rejects.toThrow("IDN_AUTHENTICATOR_KEY_INVALID")
  })
})
