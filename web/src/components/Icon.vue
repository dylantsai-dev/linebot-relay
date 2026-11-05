<script setup lang="ts">
// Icons come from lucide (open source, ISC). Components keep using short semantic names.
import { computed, type Component } from 'vue'
import {
  SquareTerminal, Sun, Moon, LogOut, Plus, Trash2, Paperclip, File, Copy, Link2, Terminal, KeyRound, ArrowUp, Search,
  Menu, RefreshCw, Check, X, Ellipsis, MessagesSquare, CircleAlert, User, Pencil, Users, ShieldCheck, Ban, Lock, ChevronDown,
  Upload, Square, Navigation, Clock, PanelLeftClose, PanelLeftOpen, ScrollText, BookOpen, Webhook, Download, FileText,
  LoaderCircle, Inbox, Activity, Hash, LogIn, UserRoundPlus, ListOrdered, ChartNoAxesColumn, Braces, Settings2, Sparkles,
  CornerDownLeft, Image, FileCode, FileArchive, MessageSquareDashed, Eye, EyeOff, CirclePause, CirclePlay, UserCog, CornerUpRight, ListEnd, Cpu, Brain, Zap, Box, RotateCcw, CircleHelp, ShieldAlert, ChevronUp,
} from 'lucide-vue-next'

const map: Record<string, Component> = {
  logo: SquareTerminal, sun: Sun, moon: Moon, logout: LogOut, plus: Plus, trash: Trash2, paperclip: Paperclip, file: File,
  copy: Copy, link: Link2, terminal: Terminal, key: KeyRound, send: ArrowUp, search: Search, menu: Menu, refresh: RefreshCw,
  check: Check, x: X, more: Ellipsis, chat: MessagesSquare, alert: CircleAlert, user: User, pencil: Pencil, users: Users,
  shield: ShieldCheck, ban: Ban, lock: Lock, chevron: ChevronDown, upload: Upload, stop: Square, steer: Navigation,
  clock: Clock, 'panel-close': PanelLeftClose, 'panel-open': PanelLeftOpen, logs: ScrollText, docs: BookOpen,
  webhook: Webhook, download: Download, 'file-text': FileText, loader: LoaderCircle, inbox: Inbox, activity: Activity,
  hash: Hash, login: LogIn, 'user-plus': UserRoundPlus, queue: ListOrdered, stats: ChartNoAxesColumn, braces: Braces,
  settings: Settings2, sparkles: Sparkles, enter: CornerDownLeft, image: Image, 'file-code': FileCode,
  'file-archive': FileArchive, empty: MessageSquareDashed, eye: Eye, pause: CirclePause, play: CirclePlay, 'eye-off': EyeOff, 'user-cog': UserCog, 'steer-to': CornerUpRight, 'list-end': ListEnd, cpu: Cpu, brain: Brain, zap: Zap, box: Box, reset: RotateCcw, help: CircleHelp, 'shield-alert': ShieldAlert, 'chevron-up': ChevronUp,
}
const props = defineProps<{ name: string; size?: number; stroke?: number }>()
const comp = computed(() => map[props.name] || map.more)
</script>
<template>
  <component :is="comp" class="icon" :size="size || 16" :stroke-width="stroke || 1.75" aria-hidden="true" />
</template>
