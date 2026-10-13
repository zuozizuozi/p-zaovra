import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"
import "../styles/desktop-workbench.css"

function WorkbenchComponents() {
  return (
    <div
      class="flex max-w-[680px] flex-col gap-6 p-8"
      style={{ color: "var(--zaovra-ink)", background: "var(--zaovra-canvas)" }}
    >
      <h1 class="text-[26px] font-semibold">Zaovra · Components</h1>
      <div class="flex flex-wrap gap-2">
        <ButtonV2 variant="contrast">Continue</ButtonV2>
        <ButtonV2 variant="outline">Review changes</ButtonV2>
        <ButtonV2 variant="ghost">Cancel</ButtonV2>
        <ButtonV2 disabled>Unavailable</ButtonV2>
      </div>
      <SettingsListV2>
        <SettingsRowV2 title="Appearance" description="Uses the existing application theme.">
          <ButtonV2 variant="outline">System</ButtonV2>
        </SettingsRowV2>
        <SettingsRowV2 title="Providers" description="Configure a model connection.">
          <ButtonV2 variant="ghost">Manage</ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
      <div class="flex gap-2">
        <span data-component="workbench-pill" data-tone="success">
          Verified
        </span>
        <span data-component="workbench-pill" data-tone="warning">
          Needs review
        </span>
        <span data-component="workbench-pill" data-tone="error">
          Interrupted
        </span>
      </div>
      <div data-component="workbench-banner">Choose a provider to start a task.</div>
    </div>
  )
}

export default { title: "App/Desktop/Workbench", component: WorkbenchComponents }
export const Components = { render: () => <WorkbenchComponents /> }
