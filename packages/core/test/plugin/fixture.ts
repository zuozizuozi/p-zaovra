import { AgentV2 } from "@zaovra-ai/core/agent"
import { AISDK } from "@zaovra-ai/core/aisdk"
import { Catalog } from "@zaovra-ai/core/catalog"
import { CommandV2 } from "@zaovra-ai/core/command"
import { Credential } from "@zaovra-ai/core/credential"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@zaovra-ai/core/effect/app-node-platform"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { FileSystem } from "@zaovra-ai/core/filesystem"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Integration } from "@zaovra-ai/core/integration"
import { Location } from "@zaovra-ai/core/location"
import { Npm } from "@zaovra-ai/core/npm"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { Reference } from "@zaovra-ai/core/reference"
import { SkillV2 } from "@zaovra-ai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
