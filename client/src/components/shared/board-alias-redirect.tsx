import { Navigate, useSearchParams } from "react-router-dom";

/**
 * Redirects a board-alias path (e.g. /pipeline) to the canonical board (/deals or /leads), carrying the
 * FULL query string along so a bookmarked URL like /pipeline?scope=all keeps its params after the hop.
 * The destination interprets the params it understands (scope, list filters); ones it doesn't are inert.
 */
export function BoardAliasRedirect({ entity }: { entity: "leads" | "deals" }) {
  const [searchParams] = useSearchParams();
  const next = searchParams.toString();
  return <Navigate to={next ? `/${entity}?${next}` : `/${entity}`} replace />;
}
