import { Show, type JSX } from "solid-js"
import { DropdownMenu } from "@zaovra-ai/ui/dropdown-menu"
import { Icon } from "@zaovra-ai/ui/icon"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { IconButtonV2 } from "@zaovra-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"

import { useCommand } from "@/context/command"
import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenuAction, type DesktopMenuEntry } from "@/desktop-menu"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"

const menuLabels = {
  "New Session": "command.session.new",
  "Open Project...": "command.project.open",
  Settings: "sidebar.settings",
  "Toggle Sidebar": "command.sidebar.toggle",
  "Toggle Terminal": "command.terminal.toggle",
  "Toggle File Tree": "command.fileTree.toggle",
  Back: "common.goBack",
  Forward: "common.goForward",
  "Previous Session": "command.session.previous",
  "Next Session": "command.session.next",
  "Previous Project": "command.project.previous",
  "Next Project": "command.project.next",
  "Export Logs...": "desktop.menu.exportLogs",
  File: "desktop.menu.file",
  Edit: "desktop.menu.edit",
  View: "desktop.menu.view",
  Go: "desktop.menu.go",
  Window: "desktop.menu.window",
  Help: "desktop.menu.help",
  Undo: "desktop.menu.undo",
  Redo: "desktop.menu.redo",
  Cut: "desktop.menu.cut",
  Copy: "desktop.menu.copy",
  Paste: "desktop.menu.paste",
  Delete: "desktop.menu.delete",
  "Select All": "desktop.menu.selectAll",
  "New Window": "desktop.menu.newWindow",
  "Close Window": "desktop.menu.closeWindow",
  Minimize: "desktop.menu.minimize",
  Maximize: "desktop.menu.maximize",
  Reload: "desktop.menu.reload",
  "Toggle Developer Tools": "desktop.menu.devTools",
  "Actual Size": "desktop.menu.actualSize",
  "Zoom In": "desktop.menu.zoomIn",
  "Zoom Out": "desktop.menu.zoomOut",
  "Toggle Full Screen": "desktop.menu.fullScreen",
  "Zaovra Documentation": "desktop.menu.documentation",
  "Support Forum": "desktop.menu.support",
} as const

export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  const language = useLanguage()
  let lastFocused: HTMLElement | undefined

  const label = (value: string) => {
    const key = menuLabels[value as keyof typeof menuLabels]
    return key ? language.t(key) : value
  }

  const rememberFocus = () => {
    const active = document.activeElement
    lastFocused = active instanceof HTMLElement ? active : undefined
  }
  const commandDisabled = (id: string) => {
    const option = props.command.options.find((option) => option.id === id)
    if (!option) return true
    return option.disabled ?? false
  }
  const runCommand = (id: string) => {
    if (commandDisabled(id)) return
    props.command.trigger(id)
  }
  const runAction = (action: DesktopMenuAction) => {
    if (action.startsWith("edit.") && lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    void props.platform.runDesktopMenuAction?.(action)
  }
  const runEntry = (entry: DesktopMenuEntry) => {
    if (entry.type === "separator") return
    if (entry.command) {
      runCommand(entry.command)
      return
    }
    if (entry.action) {
      runAction(entry.action)
      return
    }
    if (entry.href) props.platform.openLink(entry.href)
  }

  return (
    <DropdownMenu gutter={4} modal={false} placement="bottom-start">
      {props.variant === "v2" ? (
        <div
          data-component="desktop-icon-button"
          class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1"
        >
          <DropdownMenu.Trigger
            as={IconButtonV2}
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="menu" />}
            aria-label="Zaovra menu"
            onPointerDown={rememberFocus}
            onKeyDown={rememberFocus}
          />
        </div>
      ) : (
        <DropdownMenu.Trigger
          as={IconButton}
          icon="menu"
          variant="ghost"
          class="titlebar-icon rounded-md shrink-0"
          aria-label="Zaovra menu"
          onPointerDown={rememberFocus}
          onKeyDown={rememberFocus}
        />
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="desktop-app-menu">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="desktop-app-menu-heading">Zaovra</DropdownMenu.GroupLabel>
            {DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "windows")).map((menu) => (
              <DesktopMenuSubmenu label={label(menu.label)}>
                {menu.items
                  ?.filter((entry) => desktopMenuVisible(entry, "windows"))
                  .map((entry) =>
                    entry.type === "separator" ? (
                      <DropdownMenu.Separator />
                    ) : (
                      <DesktopMenuItem
                        label={
                          entry.label && menuLabels[entry.label as keyof typeof menuLabels]
                            ? label(entry.label)
                            : (entry.command &&
                                props.command.options.find((option) => option.id === entry.command)?.title) ||
                              label(entry.label ?? "")
                        }
                        keybind={entry.command ? props.command.keybind(entry.command) : entry.accelerator?.windows}
                        disabled={entry.command ? commandDisabled(entry.command) : false}
                        onSelect={() => runEntry(entry)}
                      />
                    ),
                  )}
              </DesktopMenuSubmenu>
            ))}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function DesktopMenuSubmenu(props: { label: string; children: JSX.Element }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <span data-slot="dropdown-menu-item-label">{props.label}</span>
        <span data-slot="desktop-app-menu-chevron">
          <Icon name="chevron-right" size="small" />
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent class="desktop-app-menu">{props.children}</DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

function DesktopMenuItem(props: { label: string; keybind?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenu.Item disabled={props.disabled} onSelect={props.onSelect}>
      <DropdownMenu.ItemLabel>{props.label}</DropdownMenu.ItemLabel>
      <Show when={props.keybind}>
        <span data-slot="desktop-app-menu-keybind">{props.keybind}</span>
      </Show>
    </DropdownMenu.Item>
  )
}
