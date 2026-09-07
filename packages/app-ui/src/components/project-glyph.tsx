import { Show } from "solid-js"
import { Icon } from "@zaovra-ai/ui/v2/icon"
import { ProjectAvatar } from "@zaovra-ai/ui/v2/project-avatar-v2"
import { getProjectAvatarVariant } from "@/context/layout"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"

type ProjectGlyphProject = {
  id?: string
  name?: string
  worktree: string
  icon?: { color?: string; url?: string; override?: string }
}

export function ProjectGlyph(props: { project: ProjectGlyphProject }) {
  const source = () => getProjectAvatarSource(props.project.id, props.project.icon)
  return (
    <Show
      when={source()}
      fallback={
        <span
          data-component="project-glyph"
          data-variant={getProjectAvatarVariant(props.project.icon?.color)}
          class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted"
          aria-hidden="true"
        >
          <Icon name="folder" size="small" />
        </span>
      }
    >
      <ProjectAvatar
        fallback={displayName(props.project)}
        src={source()}
        variant={getProjectAvatarVariant(props.project.icon?.color)}
      />
    </Show>
  )
}
