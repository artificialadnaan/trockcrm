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
  comments: CommentRecord[];
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
 * Two SHA strings refer to the same commit when one is a prefix of the other. Necessary, not sloppy: the
 * summary comment abbreviates inconsistently — `7d99a9c` (7) in the status table and `0ab0258f8a` (10) in
 * the "Reviewed commit" line — while the API head SHA is full length.
 */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
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
  const reviewedThisCommit = commitsMentionedByBot(input.comments).some((sha) => sameCommit(sha, headSha));

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
async function ghJsonAll(startPath: string, token: string): Promise<GhPage[]> {
  let url: string | null = `https://api.github.com${startPath}`;
  const out: GhPage[] = [];
  // A hard stop so a pathological Link cycle cannot spin the job forever; 50 pages is 5,000 records.
  for (let page = 0; url && page < 50; page += 1) {
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
    console.error(`Could not publish the commit status: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export async function main(argv = process.argv): Promise<number> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const prNumber = argv[2] ?? process.env.PR_NUMBER;
  if (!repo || !token || !prNumber) {
    console.error("Need GITHUB_REPOSITORY, GITHUB_TOKEN and a PR number (argv[2] or PR_NUMBER).");
    return 2;
  }

  const pr = (await ghOne(`/repos/${repo}/pulls/${prNumber}`, token)) as unknown as {
    head?: { sha?: string };
    draft?: boolean;
    state?: string;
  };
  const headSha = pr.head?.sha;
  if (!headSha) {
    console.error(`Could not read a head SHA for PR #${prNumber}.`);
    return 2;
  }

  // A draft is not a merge candidate; blocking one is just noise while the author is still writing.
  if (pr.draft) {
    console.log(`PR #${prNumber} is a draft — review gate not applicable.`);
    await publishStatus(repo, headSha, token, "success", "Draft — review gate not applicable.");
    return 0;
  }

  const [reviews, reactions, comments] = await Promise.all([
    ghJsonAll(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, token),
    ghJsonAll(`/repos/${repo}/issues/${prNumber}/reactions?per_page=100`, token),
    ghJsonAll(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`, token),
  ]);

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
    comments: comments.map((c) => ({
      user: String((c.user as { login?: string } | undefined)?.login ?? ""),
      body: String(c.body ?? ""),
    })),
  });

  const icon = result.verdict === "clean" ? "✅" : result.verdict === "findings" ? "❌" : "⏳";
  const line = `${icon} review gate — ${result.verdict}: ${result.reason}`;
  console.log(line);
  console.log(`(evaluated ${reviews.length} review(s), ${reactions.length} reaction(s), ${comments.length} comment(s))`);

  await publishStatus(
    repo,
    headSha,
    token,
    result.verdict === "clean" ? "success" : result.verdict === "findings" ? "failure" : "pending",
    result.reason
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `### Review findings gate\n\n${line}\n`);
  }

  return result.verdict === "clean" ? 0 : 1;
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
