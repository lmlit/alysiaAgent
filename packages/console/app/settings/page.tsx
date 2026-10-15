import { AppShell } from '@/components/app-shell'
import { ThemePicker } from '@/components/settings/theme-picker'

/**
 * 设置页（change: add-theme-system）。
 *
 * ★ 为什么新建一个页面而不是在顶栏塞个开关：
 *   主题只是第一个偏好项。后面还有称呼、通知、语言 —— 都需要落点。
 *   与其把图标挤进顶栏，不如现在就给它一个家。
 *
 * 与 `/life` 同构：本文件是 server component 的 thin wrapper，
 * 真正的交互在 `ThemePicker`（'use client'）。
 */
export default function SettingsPage() {
  return (
    <AppShell>
      <ThemePicker />
    </AppShell>
  )
}
