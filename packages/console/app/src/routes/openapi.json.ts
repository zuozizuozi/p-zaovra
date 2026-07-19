export async function GET() {
  const response = await fetch(
    "https://raw.githubusercontent.com/zuozizuozi/p-zaovra/refs/heads/dev/packages/sdk/openapi.json",
  )
  const json = await response.json()
  return json
}
