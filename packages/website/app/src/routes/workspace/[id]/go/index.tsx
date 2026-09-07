import { Navigate, useParams } from "@solidjs/router"

export default function LegacyMembershipRedirect() {
  const params = useParams()
  return <Navigate href={`/workspace/${params.id}/billing`} />
}
