# Managed Model Access

ZAOVRA does not include anonymous or promotional model inference. The desktop application and local Agent runtime remain usable without a ZAOVRA account, but every model request must use one of two explicit access paths:

1. A user-managed provider credential, including local and OpenAI-compatible endpoints.
2. An authenticated ZAOVRA credential backed by an active subscription.

## Enforcement

- Local BYOK providers do not require a ZAOVRA account and do not consume ZAOVRA-managed inference.
- The ZAOVRA provider stays disabled until a key or account connection exists.
- The managed gateway rejects missing credentials and the retired `public` credential before provider selection.
- Workspace BYOK remains valid because the workspace supplies the upstream credential.
- Internal administrative workspaces may retain an explicit operational bypass; this is not a user-facing free tier.
- A balance can supplement an existing subscription when that subscription enables overage. A balance alone does not grant managed-model access.
- Subscription and credential decisions are enforced by the gateway. Client state is advisory only.

## Durable Work

Authentication and subscription failures are non-transient provider failures. Session execution must not retry them as overloads. WorkGraph records the failed Attempt and blocks the affected Task and Goal. After the user repairs credentials or subscription, explicit resume reactivates the Goal, moves blocked Tasks to `rework`, and continues from durable state.

## Retired Paths

- Anonymous managed-model inference
- The `public` synthetic API key
- IP-based free request limits
- Promotional provider-token trials
- Free-model selection and labels in the desktop model picker
