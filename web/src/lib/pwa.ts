import { computed, reactive } from 'vue'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const state = reactive({
  deferred: null as BeforeInstallPromptEvent | null,
  installed: false,
  iosHint: false,
})

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || ('standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true)
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export const canInstall = computed(() => !!state.deferred && !state.installed && !isStandalone())
export const showIosInstallHint = computed(() => state.iosHint && !state.installed && !isStandalone())

export function registerPwa() {
  if (typeof window === 'undefined') return
  if (isStandalone()) state.installed = true
  else if (isIos()) state.iosHint = true

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    state.deferred = event as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    state.deferred = null
    state.installed = true
  })

  if ('serviceWorker' in navigator) {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`
    navigator.serviceWorker.register(swUrl, { scope: import.meta.env.BASE_URL }).catch(() => {})
  }
}

export async function installPwa() {
  const event = state.deferred
  if (!event) return false
  await event.prompt()
  const choice = await event.userChoice
  state.deferred = null
  if (choice.outcome === 'accepted') state.installed = true
  return choice.outcome === 'accepted'
}
