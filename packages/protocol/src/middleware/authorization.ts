import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { UnauthorizedError } from "../errors"

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@zaovra/HttpApiAuthorization", {
  error: UnauthorizedError,
}) {}
