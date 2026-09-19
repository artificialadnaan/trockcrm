/**
 * MERGE GATE: has the review bot signed off on THIS commit?
 *
 * WHY THIS EXISTS. On 2026-09-18 PR #1144 merged with four unresolved Codex findings, one of which made
 * the feature it shipped completely inert — the audit filter it added suppressed nothing — and another of
 * which silently dropped real edits from the audit trail. Every signal said go: build-gate green, mobile
 * green, mergeable/CLEAN. The findings were sitting in the PR the whole time, and the fixes landed on the
 * branch 31 minutes after the merge, so they never reached main at all. Recovering it cost a second PR and
 * three more review rounds.
 *
 * Green checks answer "does it build and pass tests". They do not answer "did anyone object". This does.
 *
 * THE CONVENTION IT ENCODES (from the bot's own words: "If Codex has suggestions, it will comment;
 * otherwise it will react with 👍"):
 *   - a REVIEW RECORD on the head commit  => findings, unresolved  => BLOCK
 *   - a 👍 reaction, AND the review summary naming the head commit => clean => ALLOW
 *   - anything else                                                => not reviewed yet => BLOCK
 *
 * THE 👍 IS NOT ENOUGH ON ITS OWN, and that is the whole subtlety. Reactions carry no commit, so a
 * thumbs-up earned by an earlier tip stays on the PR after you push again — exactly the stale-approval
 * shape that makes "it was green yesterday" untrue today. It only counts when the summary comment
 * independently names the commit being merged.
 *
 * FAIL CLOSED. "Not reviewed yet" blocks. A merge gate that waves through the unknown state is not a gate,
 * and the cost of being wrong is asymmetric: waiting for a review is minutes, shipping an inert feature
 * cost a day.
 */

export type ReviewVerdict = "clean" | "findings" | "not-reviewed";

export interface ReviewRecord {
  /** Login of whoever filed it, e.g. "chatgpt-codex-connector". */
  user: string;
  /** The commit the review was filed against. */
  commitId: string;
  /** GitHub review state: COMMENTED, DISMISSED, APPROVED… */
  state?: string;
}

export interface ReactionRecord {
  user: string;
  /** GitHub reaction content, e.g. "+1", "eyes". */
  content: string;
}

export interface CommentRecord {
  user: string;
  body: string;
}

export interface ReviewGateInput {
  headSha: string;
  reviews: ReviewRecord[];
  reactions: ReactionRecord[];
  /**
   * FULL 40-char SHAs the review bot named in its comments, already resolved from whatever abbreviation
   * it used. Resolution is the caller's job precisely so this function cannot be handed an abbreviation
   * and quietly prefix-match it.
   */
  mentionedCommits: string[];
}

export interface ReviewGateResult {
  verdict: ReviewVerdict;
  /** One line, written to be read in a failing check's summary. */
  reason: string;
}

/**
 * The review bot's login varies by surface — the reviews API returns `chatgpt-codex-connector` while
 * comments and reactions return `chatgpt-codex-connector[bot]` — so both spellings are listed.
 *
 * An EXACT set, never a substring. `/codex/i` would trust any account whose name happens to contain
 * "codex", and this gate's whole job is to be the thing that cannot be talked around: such an account
 * could add a 👍 and a comment quoting the head SHA and manufacture a clean verdict without any review
 * having happened. An allowlist fails safe when the bot is renamed (the gate blocks and someone updates
 * this line); a substring fails open to anyone who picks the right username.
 */
const REVIEW_BOT_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);

export function isReviewBot(login: string): boolean {
  return REVIEW_BOT_LOGINS.has(login.trim().toLowerCase());
}

/**
 * EXACT identity, both sides full length. Prefix matching used to live here, and it was a real hole: the
 * bot abbreviates to 7 hex characters in its status table, which is 28 bits — cheap to mine. With a
 * thumbs-up persisting across pushes, a contributor could craft a commit sharing the reviewed commit's
 * 7-char prefix and have it evaluated clean on arrival, without any review.
 *
 * Abbreviations are now resolved to full SHAs by the caller (GitHub errors on an ambiguous prefix, so a
 * mined collision fails closed there), and this only ever compares the resolved results.
 */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length !== 40 || y.length !== 40) return false;
  return x === y;
}

/**
 * Every commit-looking token the review bot's summary comment mentions. Deliberately shape-agnostic: the
 * bot has used at least two layouts, and a parser pinned to one of them would silently report
 * "not reviewed" forever the day the other appears — which fails closed, but noisily and for the wrong
 * reason. Any 7-40 char hex token in a bot comment is a candidate.
 */
export function commitsMentionedByBot(comments: CommentRecord[]): string[] {
  const out: string[] = [];
  for (const comment of comments) {
    if (!isReviewBot(comment.user)) continue;
    for (const match of comment.body.matchAll(/\b([0-9a-f]{7,40})\b/gi)) out.push(match[1]);
  }
  return out;
}

export function decideReviewVerdict(input: ReviewGateInput): ReviewGateResult {
  const { headSha } = input;

  // 1. Findings win, and they are checked FIRST. A PR can carry both a stale 👍 from an earlier tip and a
  //    fresh review record on this one; the objection is the newer fact and the one that matters.
  // DISMISSED reviews are excluded: GitHub keeps the record in the collection after someone dismisses it,
  // so counting it would leave the PR blocked forever by an objection that has been formally withdrawn —
  // and the workflow listens for the `dismissed` event specifically to re-evaluate.
  const findingsOnHead = input.reviews.filter(
    (r) =>
      isReviewBot(r.user) &&
      sameCommit(r.commitId, headSha) &&
      String(r.state ?? "").toUpperCase() !== "DISMISSED"
  );
  if (findingsOnHead.length > 0) {
    return {
      verdict: "findings",
      reason: `The review bot filed ${findingsOnHead.length} review(s) against ${headSha.slice(0, 9)}. Under this repo's convention a review record means unresolved findings — address them and push, or say why they do not apply.`,
    };
  }

  // 2. A clean pass is a 👍 PLUS independent evidence that this exact commit is what was reviewed.
  const thumbsUp = input.reactions.some((r) => isReviewBot(r.user) && r.content === "+1");
  const reviewedThisCommit = input.mentionedCommits.some((sha) => sameCommit(sha, headSha));

  if (thumbsUp && reviewedThisCommit) {
    return { verdict: "clean", reason: `Reviewed clean at ${headSha.slice(0, 9)}.` };
  }

  if (thumbsUp && !reviewedThisCommit) {
    return {
      verdict: "not-reviewed",
      reason: `There is a 👍 on this PR but nothing ties it to ${headSha.slice(0, 9)} — a reaction carries no commit, so it is most likely left over from an earlier push. Re-request a review on the current tip.`,
    };
  }

  return {
    verdict: "not-reviewed",
    reason: `No review verdict for ${headSha.slice(0, 9)} yet. Comment "@codex review" and wait for it to finish.`,
  };
}

// ---------------------------------------------------------------------------------------------------
// CLI. Kept under the pure logic above and deliberately thin: everything worth testing is testable
// without a network, and this half is just fetch + exit code.
// ---------------------------------------------------------------------------------------------------

interface GhPage {
  [key: string]: unknown;
}

function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * Follows `Link: rel="next"` to the end. Not optional: a long-lived PR can carry well over 100 reviews
 * (one on this repo has 30+ from a single loop), and with only the first page a findings review on the
 * head commit can sit on page two while a stale 👍 and an edited summary naming the head remain visible on
 * page one — which reads as CLEAN. Truncation makes this gate fail OPEN, which is the one direction it
 * must never fail.
 */
const MAX_PAGES = 50;

async function ghJsonAll(startPath: string, token: string): Promise<GhPage[]> {
  let url: string | null = `https://api.github.com${startPath}`;
  const out: GhPage[] = [];
  // A hard stop so a pathological Link cycle cannot spin the job forever; 50 pages is 5,000 records.
  let page = 0;
  for (; url && page < MAX_PAGES; page += 1) {
    const res: Response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "trockcrm-review-findings-gate",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
    out.push(...((await res.json()) as GhPage[]));
    url = nextPageUrl(res.headers.get("link"));
  }
  // THROW rather than return what we managed to read. Silently truncating is the same fail-OPEN this
  // function's pagination exists to prevent, just moved to the far end: past the cap, a findings review on
  // the head could sit on an unread page while an older summary and 👍 remain visible, and the gate would
  // answer CLEAN on incomplete evidence. Refusing to rule is the only safe answer when the evidence is
  // knowably partial.
  if (url) {
    throw new Error(
      `Evidence for ${startPath} exceeds ${MAX_PAGES} pages and is still paginating — refusing to rule on partial evidence.`
    );
  }
  return out;
}

async function ghOne(path: string, token: string): Promise<GhPage> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "trockcrm-review-findings-gate",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as GhPage;
}

export const STATUS_CONTEXT = "review-findings-gate";

/**
 * Publish the verdict as a COMMIT STATUS on the PR's head SHA.
 *
 * This is the authoritative signal, and it exists because of how the clean verdict arrives. A 👍 reaction
 * fires no webhook, so the only event that can tell us about one is the bot EDITING its summary comment —
 * an `issue_comment` event, whose workflow run is associated with the DEFAULT BRANCH, not the PR head. A
 * check produced by that run therefore lands on the wrong commit and can never replace the failing
 * head-associated run, leaving the PR blocked forever even after the review comes back clean.
 *
 * Writing a status directly against the fetched head SHA sidesteps the trigger entirely: statuses are
 * last-write-wins per (commit, context), so whichever run evaluates most recently owns the verdict.
 * BRANCH PROTECTION SHOULD REQUIRE THIS STATUS CONTEXT, not the workflow's own check.
 */
async function publishStatus(
  repo: string,
  sha: string,
  token: string,
  state: "success" | "failure" | "pending",
  description: string
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "trockcrm-review-findings-gate",
    },
    body: JSON.stringify({
      state,
      context: STATUS_CONTEXT,
      // GitHub truncates past 140 characters.
      description: description.slice(0, 139),
      target_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    }),
  });
  if (!res.ok) {
    // THROW, do not log and continue. This status is the authoritative signal; if the write failed
    // (rate limit, permissions, a transient 5xx) then a clean verdict never reached the commit, and
    // exiting 0 here would show a green run next to an absent-or-stale required status — the PR blocked
    // for a reason nothing on screen explains. A failed run is retryable and legible.
    throw new Error(`Could not publish the commit status: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Resolve whatever the bot abbreviated to a full 40-char SHA. Returns null when the ref does not resolve
 * or is AMBIGUOUS — GitHub answers 422 for a prefix matching more than one object, which is exactly the
 * mined-collision case, and null there means the gate declines to treat it as evidence.
 */
async function resolveCommitSha(repo: string, ref: string, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "trockcrm-review-findings-gate",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: string };
    return typeof body.sha === "string" && body.sha.length === 40 ? body.sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Evaluate one PR: gather its evidence, resolve the commits its reviewer named, and rule. */
async function evaluatePr(repo: string, prNumber: string | number, token: string) {
  const pr = (await ghOne(`/repos/${repo}/pulls/${prNumber}`, token)) as unknown as {
    head?: { sha?: string };
    draft?: boolean;
  };
  const headSha = pr.head?.sha;
  if (!headSha) throw new Error(`Could not read a head SHA for PR #${prNumber}.`);

  const [reviews, reactions, comments] = await Promise.all([
    ghJsonAll(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, token),
    ghJsonAll(`/repos/${repo}/issues/${prNumber}/reactions?per_page=100`, token),
    ghJsonAll(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`, token),
  ]);

  const mentioned = [
    ...new Set(
      commitsMentionedByBot(
        comments.map((c) => ({
          user: String((c.user as { login?: string } | undefined)?.login ?? ""),
          body: String(c.body ?? ""),
        }))
      )
    ),
  ];
  const resolved = (await Promise.all(mentioned.map((ref) => resolveCommitSha(repo, ref, token)))).filter(
    (sha): sha is string => sha != null
  );

  const result = decideReviewVerdict({
    headSha,
    reviews: reviews.map((r) => ({
      user: String((r.user as { login?: string } | undefined)?.login ?? ""),
      commitId: String(r.commit_id ?? ""),
      state: String(r.state ?? ""),
    })),
    reactions: reactions.map((r) => ({
      user: String((r.user as { login?: string } | undefined)?.login ?? ""),
      content: String(r.content ?? ""),
    })),
    mentionedCommits: resolved,
  });

  return { headSha, draft: pr.draft === true, result, counts: { reviews: reviews.length, reactions: reactions.length, comments: comments.length } };
}

/** Worst verdict wins: findings > not-reviewed > clean. */
export function worstVerdict(verdicts: ReviewVerdict[]): ReviewVerdict {
  if (verdicts.includes("findings")) return "findings";
  if (verdicts.includes("not-reviewed")) return "not-reviewed";
  return "clean";
}

export async function main(argv = process.argv): Promise<number> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const prNumber = argv[2] ?? process.env.PR_NUMBER;
  if (!repo || !token || !prNumber) {
    console.error("Need GITHUB_REPOSITORY, GITHUB_TOKEN and a PR number (argv[2] or PR_NUMBER).");
    return 2;
  }

  const primary = await evaluatePr(repo, prNumber, token);
  const { headSha } = primary;

  // A draft is not a merge candidate; blocking one is just noise while the author is still writing.
  if (primary.draft) {
    console.log(`PR #${prNumber} is a draft — review gate not applicable.`);
    await publishStatus(repo, headSha, token, "success", "Draft — review gate not applicable.");
    return 0;
  }

  // A commit status is keyed by (repo, SHA, context) and knows nothing about pull requests, while the
  // evidence is per-PR. If two open PRs share a head commit, one writing `success` would satisfy branch
  // protection on the other — which may have findings, or have never been reviewed at all. So every open
  // PR on this commit is evaluated and the WORST verdict is what gets published: the status then means
  // "every PR on this commit is clean", which is the only reading that is safe for all of them.
  const siblings = (await ghJsonAll(`/repos/${repo}/commits/${headSha}/pulls?per_page=100`, token))
    .map((pr) => ({ number: Number(pr.number), state: String(pr.state ?? "") }))
    .filter((pr) => pr.state === "open" && String(pr.number) !== String(prNumber));

  const evaluations = [primary];
  for (const sibling of siblings) {
    try {
      const evaluated = await evaluatePr(repo, sibling.number, token);
      if (evaluated.draft) continue;
      evaluations.push(evaluated);
      console.log(`  (also on this commit: PR #${sibling.number} -> ${evaluated.result.verdict})`);
    } catch (err) {
      // Fail closed: a sibling we cannot evaluate is a sibling we cannot vouch for.
      console.error(`Could not evaluate sibling PR #${sibling.number}:`, err);
      evaluations.push({
        ...primary,
        result: {
          verdict: "not-reviewed" as ReviewVerdict,
          reason: `Could not evaluate PR #${sibling.number}, which shares this commit.`,
        },
      });
    }
  }

  const verdict = worstVerdict(evaluations.map((e) => e.result.verdict));
  const reason =
    evaluations.find((e) => e.result.verdict === verdict)?.result.reason ?? primary.result.reason;

  const icon = verdict === "clean" ? "✅" : verdict === "findings" ? "❌" : "⏳";
  const line = `${icon} review gate — ${verdict}: ${reason}`;
  console.log(line);
  console.log(
    `(evaluated ${primary.counts.reviews} review(s), ${primary.counts.reactions} reaction(s), ` +
      `${primary.counts.comments} comment(s) on #${prNumber}` +
      (siblings.length > 0 ? `, plus ${siblings.length} PR(s) sharing this commit` : "") +
      ")"
  );

  await publishStatus(
    repo,
    headSha,
    token,
    verdict === "clean" ? "success" : verdict === "findings" ? "failure" : "pending",
    reason
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `### Review findings gate\n\n${line}\n`);
  }

  return verdict === "clean" ? 0 : 1;
}

const invokedDirectly =
  typeof process !== "undefined" && process.argv[1]?.endsWith("review-findings-gate.ts");
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("review gate failed:", err);
      process.exit(2);
    });
}
