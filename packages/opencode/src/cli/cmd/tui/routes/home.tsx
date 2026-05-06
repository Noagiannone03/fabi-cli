import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal } from "solid-js"
import { Logo } from "../component/logo"
import { Mascot } from "../component/mascot"
import { SwarmIndicator } from "../component/swarm-indicator"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { useTheme } from "@tui/context/theme"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const project = useProject()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const { theme } = useTheme()
  let sent = false

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0} alignItems="center">
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <box flexDirection="row" alignItems="flex-end" gap={3}>
              <Logo inkLeft={theme.primary} inkRight={theme.text} />
              <Mascot />
            </box>
          </TuiPluginRuntime.Slot>
          <box paddingTop={2} flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>code</text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.text}>peer to peer</text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.primary}>open source</text>
          </box>
          <box paddingTop={1}>
            <SwarmIndicator />
          </box>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <TuiPluginRuntime.Slot
            name="home_prompt"
            mode="replace"
            workspace_id={project.workspace.current()}
            ref={bind}
          >
            <Prompt
              ref={bind}
              workspaceID={project.workspace.current()}
              right={<TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />}
              placeholders={placeholder}
            />
          </TuiPluginRuntime.Slot>
        </box>
        <TuiPluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box
        width="100%"
        flexShrink={0}
        flexDirection="row"
        justifyContent="flex-end"
        paddingRight={2}
        paddingBottom={0}
      >
        <text fg={theme.textMuted}>empowered by undefined studio</text>
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
