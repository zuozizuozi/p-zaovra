import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("update", update)
      .handle("directories", directories)
  }),
)
