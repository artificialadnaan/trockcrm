import { useQuery } from "@tanstack/react-query";
import * as authApi from "../api/endpoints/auth";
import { useAuth } from "./AuthContext";
import { useOfficeId } from "./useOfficeId";
import { qk } from "../query/keys";

/**
 * The offices this user can reach, and the NAME of the one they are in.
 *
 * The dashboard rendered `activeOfficeId` directly — a UUID. That is an internal identifier: it tells a
 * user nothing, and tells a user who works across two offices nothing about which one they are looking
 * at, which is the only question the field actually cares about. Offices are separate Postgres schemas,
 * so "which office am I in" changes every number on every screen.
 *
 * Cached hard: office membership changes about never, and this rides along on screens that already have
 * work to do.
 */
export function useOffices() {
  const { session, fetcher } = useAuth();
  const activeOfficeId = useOfficeId();

  const query = useQuery({
    queryKey: qk.offices(),
    queryFn: () => authApi.accessibleOffices(fetcher, session?.token ?? ""),
    enabled: Boolean(session),
    staleTime: 60 * 60_000,
    // A name is a nicety; failing to load one must never surface as an error on a screen that otherwise
    // works, so this simply resolves to no name.
    retry: 1,
  });

  const offices = query.data ?? [];
  const activeOffice = offices.find((o) => o.id === activeOfficeId) ?? null;

  return {
    offices,
    activeOfficeId,
    activeOffice,
    /** The display name, or null — NEVER the id. A UUID on screen is worse than no label at all. */
    activeOfficeName: activeOffice?.name ?? null,
    /** Only worth offering a switcher when there is somewhere to switch to. */
    canSwitchOffice: offices.length > 1,
    isLoading: query.isLoading,
    /**
     * EXPOSED so a screen's pull-to-refresh can include it.
     *
     * `retry: 1` and no refetchOnWindowFocus means that once both attempts fail, nothing retries this
     * on its own. The dashboard could then refresh its deal count all day and the office name would
     * stay blank — leaving a multi-office rep looking at office-scoped totals with no indication which
     * office they belong to, and no way to find out short of restarting the app.
     */
    refetch: query.refetch,
  };
}
