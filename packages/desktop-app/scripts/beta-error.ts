type Operation =
  | "ValidatePublishIdentity"
  | "VerifySigningPolicy"
  | "ConfigureR2Bucket"
  | "VerifyBetaPointer"
  | "PublishBeta"
  | "PlanBeta"
  | "ReadReleaseNotes"
  | "ReserveBeta"
  | "Retention"
  | "R2 GET"
  | "R2 PUT"
  | "R2 LIST"
  | "R2 HEAD"
  | "R2 DELETE"
  | "Public GET"

export class BetaError extends Error {
  constructor(
    readonly operation: Operation,
    cause: unknown,
    message = "Beta operation failed",
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message, { cause })
  }
}

export function betaErrorDetails(error: unknown, operation: Operation) {
  const chain = [error]
  for (let depth = 0; depth < 4 && chain.at(-1) instanceof BetaError; depth++)
    chain.push((chain.at(-1) as BetaError).cause)
  const records = chain.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
  const name = records.at(-1)?.name
  const status = records
    .flatMap((value) => [value.status, value.statusCode])
    .find((value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
  return {
    operation: error instanceof BetaError ? error.operation : operation,
    // Error messages, stacks, URLs, headers and arbitrary server fields may contain credentials.
    name:
      typeof name === "string" &&
      [
        "Error",
        "S3Error",
        "TypeError",
        "RangeError",
        "SyntaxError",
        "AbortError",
        "TimeoutError",
        "SystemError",
      ].includes(name)
        ? name
        : "UnknownError",
    status: status ?? null,
    code: records.map((value) => safeCode(value.code)).find(Boolean) ?? null,
  }
}

export async function betaOperation<T>(operation: Operation, action: () => T | Promise<T>) {
  try {
    return await action()
  } catch (error) {
    throw error instanceof BetaError ? error : new BetaError(operation, error)
  }
}

export async function betaResponseError(response: Response, operation: Operation, message: string) {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (reader && length < 4096) {
    const next = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (next.done || !next.value) break
    const chunk = next.value.subarray(0, 4096 - length)
    chunks.push(chunk)
    length += chunk.length
  }
  await reader?.cancel().catch(() => {})
  const body = Buffer.concat(chunks).toString("utf8")
  const code = safeCode(/<Code>\s*([A-Za-z0-9_]+)\s*<\/Code>/.exec(body)?.[1])
  return new BetaError(operation, new Error(message), message, response.status, code)
}

function safeCode(value: unknown) {
  if (typeof value !== "string") return undefined
  return [
    "AccessDenied",
    "NoSuchBucket",
    "NoSuchKey",
    "SignatureDoesNotMatch",
    "InvalidAccessKeyId",
    "ExpiredToken",
    "InvalidToken",
    "RequestTimeTooSkewed",
    "SlowDown",
    "InternalError",
    "ServiceUnavailable",
    "PreconditionFailed",
    "InvalidRequest",
    "AuthorizationHeaderMalformed",
    "PermanentRedirect",
    "InvalidBucketName",
    "RequestTimeout",
    "NotImplemented",
    "ERR_S3_MISSING_CREDENTIALS",
    "ERR_S3_INVALID_METHOD",
    "ERR_S3_INVALID_PATH",
    "ERR_S3_INVALID_ENDPOINT",
    "ERR_S3_INVALID_SIGNATURE",
    "ERR_S3_INVALID_SESSION_TOKEN",
  ].includes(value)
    ? value
    : undefined
}
