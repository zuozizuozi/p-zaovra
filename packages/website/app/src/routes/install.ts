// Desktop builds link here for install instructions; the download page carries the current release status.
export function GET() {
  return new Response(null, { status: 302, headers: { location: "/download" } })
}
