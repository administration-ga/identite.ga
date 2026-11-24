import React from "react"
import { Platform } from "react-native"
import Constants from "expo-constants"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import { useRouter, useSegments } from "expo-router"
import { useConvexAuth, useMutation } from "convex/react"
import { api } from "@/lib/api"
import { canOpenPush, pushNavigation } from "@/lib/push-navigation"

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export function MobilePushBootstrap() {
  const router = useRouter()
  const { isAuthenticated, isLoading } = useConvexAuth()
  const segments = useSegments()
  const root = segments[0] ?? "index"
  const pending = React.useSyncExternalStore(
    pushNavigation.subscribe, pushNavigation.getSnapshot, pushNavigation.getSnapshot,
  )
  const subscribe = useMutation(api.nativePushSubscriptions.subscribe)
  const registered = React.useRef(false)

  React.useEffect(() => {
    if (Platform.OS === "web") return
    let active = true
    let receivedLiveResponse = false
    const receive = (response: Notifications.NotificationResponse) => {
      const request = response.notification.request
      pushNavigation.receive(
        `${request.identifier}:${response.actionIdentifier}:${response.notification.date}`,
        request.content.data?.url,
      )
      void Notifications.clearLastNotificationResponseAsync().catch(() => {})
    }
    const listener = Notifications.addNotificationResponseReceivedListener((response) => {
      receivedLiveResponse = true
      receive(response)
    })
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      // Ne pas rejouer une ancienne réponse après un clic plus récent, ni
      // depuis un effet démonté (notamment sous StrictMode).
      if (active && !receivedLiveResponse && response) receive(response)
    }).catch(() => { /* Une lecture impossible ne doit pas bloquer le lancement. */ })
    return () => {
      active = false
      listener.remove()
    }
  }, [])

  React.useEffect(() => {
    if (!pushNavigation.getSnapshot() || !canOpenPush(isAuthenticated, isLoading, root)) return
    router.push(pushNavigation.take() as never)
  }, [isAuthenticated, isLoading, pending, root, router])

  React.useEffect(() => {
    if (!isAuthenticated) {
      registered.current = false
      return
    }
    if (Platform.OS === "web" || registered.current) return
    registered.current = true
    void (async () => {
      if (!Device.isDevice) {
        registered.current = false
        return
      }
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("messages", {
          name: "Nouveaux messages",
          description: "E-mails et courriers reçus dans iBoîte",
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 180, 120, 180],
        })
      }
      const current = await Notifications.getPermissionsAsync()
      const permission = current.granted
        ? current
        : await Notifications.requestPermissionsAsync()
      if (!permission.granted) {
        registered.current = false
        return
      }
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        Constants.easConfig?.projectId
      if (!projectId) {
        registered.current = false
        return
      }
      const token = (await Notifications.getExpoPushTokenAsync({ projectId }))
        .data
      await subscribe({
        token,
        platform: Platform.OS as "ios" | "android",
        deviceName: Device.deviceName ?? undefined,
      })
    })().catch(() => {
      registered.current = false
    })
  }, [isAuthenticated, subscribe])

  return null
}
