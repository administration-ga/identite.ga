/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach } from "vitest"
import { z } from "zod"

import schema from "../convex/schema"

const modules = import.meta.glob("../convex/**/*.ts")

// convex-test 0.0.65 ne connaît pas encore storageStore/storageGet ni les
// métriques fichiers de convex 1.48. Cet adaptateur de tests traduit ces
// syscalls vers son stockage existant. Les écritures _storage restent dans
// sa transaction simulée ; ce n'est pas une validation du runtime serveur.
declare const Convex: {
  asyncSyscall: (op: string, args: string) => Promise<string>
  jsSyscall: (op: string, args: Record<string, unknown>) => Promise<unknown>
}

export const storageTestState = {
  filesRemaining: 1000,
  bytesRemaining: 64 * 1024 * 1024,
  stores: 0,
  failStore: false,
  urlUnavailable: false,
  schedules: 0,
  failScheduleAt: 0,
}

let originalDescriptor: PropertyDescriptor | undefined

beforeEach(async () => {
  // Installer le proxy et lire ses getters dans un contexte Convex actif.
  const bootstrap = convexTest({ schema, modules })
  Object.assign(storageTestState, {
    filesRemaining: 1000,
    bytesRemaining: 64 * 1024 * 1024,
    stores: 0,
    failStore: false,
    urlUnavailable: false,
    schedules: 0,
    failScheduleAt: 0,
  })
  await bootstrap.run(async () => {
    const nativeAsyncSyscall = Convex.asyncSyscall
    const nativeJsSyscall = Convex.jsSyscall
    originalDescriptor = Object.getOwnPropertyDescriptor(Convex, "asyncSyscall")
    const bridge = async (op: string, jsonArgs: string): Promise<string> => {
      if (op === "1.0/storageGetUrl" && storageTestState.urlUnavailable) {
        return "null"
      }
      if (op === "1.0/storageStore") {
        storageTestState.stores++
        if (storageTestState.failStore)
          throw new Error("injected storage failure")
        const args = z
          .object({ blob: z.string(), contentType: z.string() })
          .parse(JSON.parse(jsonArgs))
        const bytes = Uint8Array.from(atob(args.blob), (c) => c.charCodeAt(0))
        const storageId = await nativeJsSyscall("storage/storeBlob", {
          blob: new Blob([bytes], { type: args.contentType }),
        })
        return JSON.stringify(storageId)
      }
      if (op === "1.0/storageGet") {
        const args = z
          .object({ storageId: z.string() })
          .parse(JSON.parse(jsonArgs))
        const blob = await nativeJsSyscall("storage/getBlob", args)
        if (blob === null) return "null"
        if (!(blob instanceof Blob))
          throw new Error("Unexpected convex-test blob")
        let binary = ""
        for (const byte of new Uint8Array(await blob.arrayBuffer()))
          binary += String.fromCharCode(byte)
        return JSON.stringify({ blob: btoa(binary), contentType: blob.type })
      }
      if (op === "1.0/getTransactionMetrics") {
        const metrics = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(await nativeAsyncSyscall(op, jsonArgs)))
        return JSON.stringify({
          ...metrics,
          filesWritten: { used: 0, remaining: storageTestState.filesRemaining },
          fileWriteBytes: {
            used: 0,
            remaining: storageTestState.bytesRemaining,
          },
        })
      }
      if (op === "1.0/schedule" || op === "1.0/actions/schedule") {
        storageTestState.schedules++
        if (storageTestState.schedules === storageTestState.failScheduleAt) {
          throw new Error("injected scheduler failure")
        }
      }
      return await nativeAsyncSyscall(op, jsonArgs)
    }
    Object.defineProperty(Convex, "asyncSyscall", {
      configurable: true,
      get: () => bridge,
    })
  })
})

afterEach(() => {
  if (originalDescriptor)
    Object.defineProperty(Convex, "asyncSyscall", originalDescriptor)
})
