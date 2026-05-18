USER SMOKE TEST:
(1) Open a deal that has 0 associated emails
(2) Check the email tab badge — should show 0 (or no badge), not 1
(3) Open a deal that has emails directly assigned — badge should match the actual count
(4) Open a deal that has emails via its source lead (post-conversion) — badge should include those
(5) Trigger a recompute by assigning then unassigning an email — verify count updates correctly

Assumptions:
- Production smoke remains banned for this hotfix, so this note is for post-merge manual validation only.
- Any currently drifted production deal counts should self-correct on the next assign, ignore, un-ignore, or outbound-send recompute path; if drift is widespread, consider a one-time recompute run using the same SQL shape as migration `0125`.
