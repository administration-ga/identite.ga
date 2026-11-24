import React, { useState } from "react"
import { Alert, Modal, Pressable, View } from "react-native";
import { Text } from "@/design/text";
import { useLocalSearchParams, useRouter } from "expo-router"
import { useConvexAuth, useMutation, useQuery } from "convex/react"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useIdnTheme } from "@/design/theme"
import { IdnButton } from "@/design/components/idn-button"
import { IdnInput } from "@/design/components/idn-input"
import { AppBar } from "@/design/components/app-bar"
import { Screen } from "@/design/components/screen"
import { Card, ErrorNote, Note, Row, SectionTitle } from "@/design/components/list"
import { Keypad, PinDots } from "@/design/components/pin-pad"
import { maskNip } from "@/lib/nip-format"
import { BIOMETRIC, BIOMETRIC_TITLE } from "@/lib/biometric-label"
import { api } from "@/lib/api"
import { authClient } from "@/lib/auth-client"

import { deletePasskey, listPasskeys, passkeyErrorMessage, PasskeyUnavailableError, setPasskeyForSession, type Passkey } from "@/lib/passkeys"
import { biometricAvailable, confirmWithBiometrics, faceUnlockEnabledFor, setFaceUnlockForSession } from "@/lib/face-unlock"
import { readAuthenticatorState } from "@/lib/authenticator/device"
import { secureAuthenticatorStorage } from "@/lib/authenticator/secure-storage"
import { provisionThisDevice } from "@/lib/authenticator/this-device"

function fmtDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

function PinChangeModal({
  visible,
  configured,
  onClose,
}: {
  visible: boolean
  configured: boolean
  onClose: () => void
}) {
  const t = useIdnTheme()
  const insets = useSafeAreaInsets()
  const createPin = useMutation(api.onboarding.createPin)
  const changePin = useMutation(api.onboarding.changePin)
  const [phase, setPhase] = useState<"check" | "new" | "confirm">("check")
  const [pin, setPin] = useState("")
  const [currentPin, setCurrentPin] = useState("")
  const [newPin, setNewPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setPhase(configured ? "check" : "new")
    setPin("")
    setCurrentPin("")
    setNewPin("")
    setError(null)
    setSubmitting(false)
  }

  function close() {
    reset()
    onClose()
  }

  async function complete(value: string) {
    setError(null)
    if (phase === "check") {
      setCurrentPin(value)
      setPhase("new")
      setPin("")
      return
    }
    if (phase === "new") {
      setNewPin(value)
      setPhase("confirm")
      setPin("")
      return
    }
    if (value !== newPin) {
      setError("Les deux codes sont différents.")
      setPhase("new")
      setPin("")
      setNewPin("")
      return
    }
    setSubmitting(true)
    try {
      if (configured) await changePin({ currentPin, newPin: value })
      else await createPin({ pin: value })
      close()
      Alert.alert("Code PIN modifié", "Ton nouveau code PIN est actif.")
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Modification impossible.",
      )
      setPin("")
      setSubmitting(false)
    }
  }

  function press(key: string) {
    if (!key || submitting) return
    if (key === "⌫") {
      setPin((value) => value.slice(0, -1))
      return
    }
    if (pin.length >= 6) return
    const value = pin + key
    setPin(value)
    if (value.length === 6) void complete(value)
  }

  const title =
    phase === "check"
      ? "Ton code PIN actuel"
      : phase === "new"
        ? "Ton nouveau code PIN"
        : "Confirme le nouveau code"
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onShow={reset} onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingBottom: Math.max(insets.bottom, 12) }}>
        <AppBar title={configured ? "Changer le code PIN" : "Créer un code PIN"} onBack={close} backIcon="close" />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 }}>
          <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: "600", color: t.ink }}>{title}</Text>
          <Text style={{ marginTop: 6, fontSize: 14, color: t.muted, textAlign: "center" }}>6 chiffres. Évite ta date de naissance.</Text>
          <PinDots filled={pin.length} error={!!error} />
          <View style={{ alignSelf: "stretch" }}>
            <ErrorNote>{error}</ErrorNote>
          </View>
        </View>
        <Keypad
          onDigit={(d) => press(d)}
          onDelete={() => press("⌫")}
          disabled={submitting}
        />
      </View>
    </Modal>
  )
}

function NipChangeModal({
  visible,
  currentNip,
  onClose,
}: {
  visible: boolean
  currentNip?: string
  onClose: () => void
}) {
  const t = useIdnTheme()
  const insets = useSafeAreaInsets()
  const updateNip = useMutation(api.profile.updateNip)
  const [nip, setNip] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function close() {
    setNip("")
    setError(null)
    setSubmitting(false)
    onClose()
  }

  async function submit() {
    if (!/^[A-Za-z0-9]{14}$/.test(nip)) {
      setError("Le NIP doit contenir exactement 14 lettres ou chiffres.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await updateNip({ nip })
      close()
      Alert.alert(
        "NIP enregistré",
        "Ton numéro d’identification personnel est à jour.",
      )
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Mise à jour impossible.",
      )
      setSubmitting(false)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingBottom: Math.max(insets.bottom, 12) }}>
        <AppBar title="Numéro d’identification (NIP)" onBack={close} backIcon="close" />
        <View style={{ padding: 20, gap: 16 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: t.muted }}>
            {currentNip
              ? "Ton NIP figure sur ta carte d’identité. Corrige-le seulement s’il est erroné."
              : "Saisis le NIP de 14 caractères inscrit sur ta carte d’identité."}
          </Text>
          <IdnInput
            t={t}
            label="NIP"
            value={nip}
            onChangeText={(v) => setNip(v.replace(/\s+/g, "").toUpperCase())}
            placeholder={currentNip ?? "14 lettres ou chiffres"}
            autoCapitalize="characters"
            maxLength={14}
            mono
            error={error ?? undefined}
          />
          <IdnButton t={t} full onPress={submit} loading={submitting} disabled={nip.length !== 14}>Enregistrer</IdnButton>
        </View>
      </View>
    </Modal>
  )
}

export default function SettingsSecurity() {
  const t = useIdnTheme()
  const router = useRouter()
  const { isAuthenticated } = useConvexAuth()
  const user = useQuery(
    api.profile.getCurrentUser,
    isAuthenticated ? {} : "skip",
  )
  // « Changer le code PIN » depuis le Profil ouvre directement la saisie.
  const { action } = useLocalSearchParams<{ action?: string }>()
  const [pinOpen, setPinOpen] = useState(action === "pin")
  const [nipOpen, setNipOpen] = useState(false)
  const [faceUnlock, setFaceUnlock] = useState(false)
  const [passkeys, setPasskeys] = useState<Passkey[] | undefined>()
  const [pkError, setPkError] = useState<string | null>(null)
  const [pkUnavailable, setPkUnavailable] = useState(false)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Appareil de confiance de ce téléphone : identifiant local et compte (SecureStore).
  const [localDevice, setLocalDevice] = useState<{ userId: string; installationId: string | null; hasSecret: boolean } | null>(null)
  const [renewing, setRenewing] = useState(false)
  const devices = useQuery(api.partnerMfa.devices.myDevices, isAuthenticated ? {} : "skip")
  const links = useQuery(api.partnerMfa.links.myLinks, isAuthenticated ? {} : "skip")
  const revokeLink = useMutation(api.partnerMfa.links.revokeLink)
  const registerDevice = useMutation(api.partnerMfa.devices.registerDevice)
  const rotateDevice = useMutation(api.partnerMfa.devices.rotateDevice)

  const loadPasskeys = React.useCallback(async () => {
    try {
      const list = await listPasskeys()
      // Plus aucune clé sur le compte : la connexion ne doit plus en proposer.
      if (list.length === 0) await setPasskeyForSession(false)
      setPasskeys(list)
      setPkError(null)
    } catch (caught) {
      setPasskeys([])
      setPkUnavailable(caught instanceof PasskeyUnavailableError)
      setPkError(
        caught instanceof Error ? caught.message : "Chargement impossible.",
      )
    }
  }, [])

  React.useEffect(() => {
    void faceUnlockEnabledFor(user?.email).then(setFaceUnlock)
  }, [user?.email])

  React.useEffect(() => {
    if (isAuthenticated) void loadPasskeys()
  }, [isAuthenticated, loadPasskeys])

  const loadLocalDevice = React.useCallback(async () => {
    const session = await authClient.getSession()
    const userId = session?.data?.user?.id as string | undefined
    if (!userId) return
    const state = await readAuthenticatorState(secureAuthenticatorStorage, userId)
    setLocalDevice({ userId, installationId: state.installationId, hasSecret: state.secret !== null })
  }, [])

  React.useEffect(() => {
    if (isAuthenticated) void loadLocalDevice()
  }, [isAuthenticated, loadLocalDevice])

  async function renewDevice() {
    if (!localDevice || renewing) return
    setRenewing(true)
    try {
      await provisionThisDevice({
        userId: localDevice.userId,
        register: registerDevice,
        rotate: rotateDevice,
        force: true,
      })
      await loadLocalDevice()
      Alert.alert("Appareil réenregistré", "Les codes de connexion de ce téléphone ont été renouvelés.")
    } catch (caught) {
      Alert.alert(
        "Réenregistrement impossible",
        caught instanceof Error ? caught.message : "Réessaie dans un instant.",
      )
    } finally {
      setRenewing(false)
    }
  }

  function removeLink(clientId: string, clientName: string) {
    Alert.alert(
      "Retirer l’accès ?",
      `${clientName} ne pourra plus te demander de confirmer tes connexions. Il te demandera une autre méthode de vérification à ta prochaine connexion.`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Retirer l’accès",
          style: "destructive",
          onPress: async () => {
            try {
              await revokeLink({ clientId })
            } catch (caught) {
              Alert.alert("Retrait impossible", caught instanceof Error ? caught.message : "Réessaie plus tard.")
            }
          },
        },
      ],
    )
  }

  async function toggleBiometrics(enabled: boolean) {
    if (!enabled) {
      await setFaceUnlockForSession(false)
      setFaceUnlock(false)
      return
    }
    if (!(await biometricAvailable())) {
      Alert.alert(
        "Biométrie indisponible",
        "Configure Face ID, Touch ID ou la biométrie Android dans les réglages du téléphone.",
      )
      return
    }
    if (!(await confirmWithBiometrics(`Activer ${BIOMETRIC}`))) return
    await setFaceUnlockForSession(true)
    setFaceUnlock(true)
  }

  async function addPasskey(kind: "device" | "security-key") {
    if (adding) return
    setAdding(true)
    setPkError(null)
    try {
      const result = await authClient.passkey.addPasskey(
        kind === "device"
          ? { name: `Clé d’accès de cet appareil · ${fmtDate(Date.now())}`, authenticatorAttachment: "platform" }
          : { name: `Clé de sécurité · ${fmtDate(Date.now())}`, authenticatorAttachment: "cross-platform" },
      )
      if (result?.error)
        throw new Error(passkeyErrorMessage(result.error, "Ajout impossible."))
      // Créée depuis cet appareil : la connexion la proposera d'office.
      await setPasskeyForSession(true)
      await loadPasskeys()
    } catch (caught) {
      setPkError(caught instanceof Error ? caught.message : "Ajout impossible.")
    } finally {
      setAdding(false)
    }
  }

  function removePasskey(passkey: Passkey) {
    Alert.alert(
      "Supprimer cette clé ?",
      `${passkey.name || "Clé sans nom"} ne pourra plus servir à te connecter.`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Supprimer",
          style: "destructive",
          onPress: async () => {
            setDeleting(passkey.id)
            try {
              await deletePasskey(passkey.id)
              await loadPasskeys()
            } catch (caught) {
              setPkError(
                caught instanceof Error
                  ? caught.message
                  : "Suppression impossible.",
              )
            } finally {
              setDeleting(null)
            }
          },
        },
      ],
    )
  }

  const pinConfigured = user?.profile?.pinConfigured ?? false
  const currentNip = user?.profile?.pivot?.nip
  const keySummary = pkError
    ? pkError
    : passkeys === undefined
      ? "Chargement…"
      : `${passkeys.length} clé${passkeys.length > 1 ? "s" : ""} enregistrée${passkeys.length > 1 ? "s" : ""}`

  return (
    <Screen header={<AppBar title="Sécurité" onBack={() => router.back()} />}>
      <SectionTitle>Identifiants</SectionTitle>
      <Card>
        <Row icon="lock" title={pinConfigured ? "Changer le code PIN" : "Créer un code PIN"} sub="6 chiffres pour te connecter et valider tes actions" chevron onPress={() => setPinOpen(true)} />
        <Row icon="pin" title="NIP" sub={currentNip ? maskNip(currentNip) : "Non renseigné"} mono={!!currentNip} chevron onPress={() => setNipOpen(true)} />
        <Row icon="keyRound" title="Code PIN oublié" sub="Réinitialisation par SMS" chevron onPress={() => router.push(user?.email ? (`/(auth)/forgot-pin?identifier=${encodeURIComponent(user.email)}` as never) : ("/(auth)/forgot-pin" as never))} />
      </Card>

      <SectionTitle>Biométrie</SectionTitle>
      <Card>
        <Row
          icon="scanFace"
          title={BIOMETRIC_TITLE}
          sub={faceUnlock ? `Déverrouillage par ${BIOMETRIC} activé sur cet appareil` : "Déverrouille l’app sans saisir ton PIN"}
          right={
            <Pressable
              onPress={() => void toggleBiometrics(!faceUnlock)}
              accessibilityRole="switch"
              accessibilityState={{ checked: faceUnlock }}
              accessibilityLabel={BIOMETRIC_TITLE}
              style={{ width: 52, height: 32, borderRadius: 9999, padding: 3, backgroundColor: faceUnlock ? t.green : t.border, justifyContent: "center" }}
            >
              <View style={{ width: 26, height: 26, borderRadius: 9999, backgroundColor: "#fff", alignSelf: faceUnlock ? "flex-end" : "flex-start" }} />
            </Pressable>
          }
        />
      </Card>

      <SectionTitle>Confirmation des connexions</SectionTitle>
      <Card>
        <Row
          icon="smartphone"
          title="Cet appareil"
          sub={
            !localDevice
              ? "Chargement…"
              : devices?.some((d) => d.installationId === localDevice.installationId) && localDevice.hasSecret
                ? "Enregistré : les demandes arrivent sur ce téléphone"
                : "Non enregistré : réenregistre-le pour recevoir les demandes"
          }
          right={
            <Pressable
              onPress={() => void renewDevice()}
              disabled={!localDevice || renewing}
              accessibilityRole="button"
              accessibilityLabel="Réenregistrer cet appareil"
              hitSlop={8}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.greenText }}>{renewing ? "…" : "Réenregistrer"}</Text>
            </Pressable>
          }
        />
        <Row icon="clock" title="Codes de connexion" sub="Un code qui change toutes les 30 s, même hors réseau" chevron onPress={() => router.push("/settings/connection-codes" as never)} />
        <Row icon="history" title="Activité de confirmation" sub="Demandes acceptées et refusées" chevron onPress={() => router.push("/settings/confirmation-activity" as never)} />
      </Card>

      <SectionTitle>Services liés</SectionTitle>
      <Card>
        {links === undefined ? (
          <Row icon="link" title="Chargement…" />
        ) : links.length === 0 ? (
          <Row icon="link" title="Aucun service lié" sub="Un service apparaît ici après que tu as confirmé son premier accès." />
        ) : (
          links.map((link) => (
            <Row
              key={link.clientId}
              icon="link"
              tone="green"
              title={link.clientName}
              sub={`Connexion et confirmation · lié le ${fmtDate(link.createdAt)}`}
              right={
                <Pressable
                  onPress={() => removeLink(link.clientId, link.clientName)}
                  accessibilityRole="button"
                  accessibilityLabel={`Retirer l’accès de ${link.clientName}`}
                  hitSlop={8}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: t.redText }}>Retirer l’accès</Text>
                </Pressable>
              }
            />
          ))
        )}
      </Card>

      <SectionTitle>Clés d’accès</SectionTitle>
      {pkUnavailable ? (
        <Note style={{ marginTop: 0, marginBottom: 10 }}>Les clés d’accès ne sont pas encore activées sur le service IDN. Connecte-toi avec ton code PIN en attendant.</Note>
      ) : null}
      {pkUnavailable ? null : <Text style={{ fontSize: 13, lineHeight: 19, color: pkError ? t.redText : t.muted, marginBottom: 8 }}>{keySummary}</Text>}
      <Card>
        {(passkeys ?? []).map((pk) => (
          <Row
            key={pk.id}
            icon="keyRound"
            tone="green"
            title={pk.name || "Clé sans nom"}
            sub={`Ajoutée le ${fmtDate(pk.createdAt)}`}
            right={
              <Pressable onPress={() => removePasskey(pk)} disabled={deleting !== null} accessibilityRole="button" accessibilityLabel={`Supprimer ${pk.name || "la clé"}`} hitSlop={8}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: t.redText }}>{deleting === pk.id ? "…" : "Supprimer"}</Text>
              </Pressable>
            }
          />
        ))}
        <Row icon="plus" title="Créer une clé d’accès sur cet appareil" sub={pkUnavailable ? "Pas encore disponible" : "Connexion sans PIN quand tu es déconnecté"} chevron={!pkUnavailable} onPress={pkUnavailable ? undefined : () => void addPasskey("device")} disabled={adding} />
        <Row icon="plus" title="Ajouter une clé de sécurité" sub={pkUnavailable ? "Pas encore disponible" : "Clé physique ou autre appareil"} chevron={!pkUnavailable} onPress={pkUnavailable ? undefined : () => void addPasskey("security-key")} disabled={adding} />
      </Card>
      <Note>{`${BIOMETRIC_TITLE} déverrouille l’app quand tu es déjà connecté. Une clé d’accès (passkey) te connecte sans PIN quand tu es déconnecté : elle reste sur ton appareil et n’est jamais envoyée à IDN.`}</Note>

      <PinChangeModal visible={pinOpen} configured={pinConfigured} onClose={() => setPinOpen(false)} />
      <NipChangeModal visible={nipOpen} currentNip={currentNip} onClose={() => setNipOpen(false)} />
    </Screen>
  )
}
