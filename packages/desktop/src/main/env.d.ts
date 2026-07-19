interface ImportMetaEnv {
  readonly ZAOVRA_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:zaovra-server" {
  export namespace Server {
    export const listen: typeof import("../../../zaovra/dist/types/src/node").Server.listen
    export type Listener = import("../../../zaovra/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../zaovra/dist/types/src/node").Config.get
    export type Info = import("../../../zaovra/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../zaovra/dist/types/src/node").bootstrap
}
