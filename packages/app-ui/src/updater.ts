import type { Accessor } from "solid-js"

export function formatVersion(version: string | undefined) {
  if (!version) return ""
  const beta = /^(\d+)\.(\d+)\.(\d+)-beta\.[1-9]\d*$/.exec(version)
  if (beta && (Number(beta[1]) > 0 || Number(beta[2]) >= 2)) return `Beta ${beta[1]}.${beta[2]}.${beta[3]}`
  return version
}

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  autoCheck?(): Promise<boolean>
  setAutoCheck?(enabled: boolean): Promise<boolean>
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  download(): Promise<UpdaterState>
  install(): Promise<void>
}
