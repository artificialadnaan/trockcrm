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

/** The review bot's login varies by surface ("chatgpt-codex-connector" vs "…[bot]"), so match the name. */
export function isReviewBot(login: string): boolean {
  return /codex/i.test(login);
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
  const findingsOnHead = input.reviews.filter((r) => isReviewBot(r.user) && sameCommit(r.commitId, headSha));
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

async function ghJson(path: string, token: string): Promise<GhPage[]> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "trockcrm-review-findings-gate",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as GhPage[];
}

export async function main(argv = process.argv): Promise<number> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const prNumber = argv[2] ?? process.env.PR_NUMBER;
  if (!repo || !token || !prNumber) {
    console.error("Need GITHUB_REPOSITORY, GITHUB_TOKEN and a PR number (argv[2] or PR_NUMBER).");
    return 2;
  }

  const pr = (await ghJson(`/repos/${repo}/pulls/${prNumber}`, token)) as unknown as {
    head?: { sha?: string };
    draft?: boolean;
  };
  const headSha = pr.head?.sha;
  if (!headSha) {
    console.error(`Could not read a head SHA for PR #${prNumber}.`);
    return 2;
  }

  // A draft is not a merge candidate; blocking one would just be noise in the author's face while they
  // are still writing it.
  if (pr.draft) {
    console.log(`PR #${prNumber} is a draft — review gate not applicable.`);
    return 0;
  }

  const [reviews, reactions, comments] = await Promise.all([
    ghJson(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, token),
    ghJson(`/repos/${repo}/issues/${prNumber}/reactions?per_page=100`, token),
    ghJson(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`, token),
  ]);

  const result = decideReviewVerdict({
    headSha,
    reviews: reviews.map((r) => ({
      user: String((r.user as { login?: string } | undefined)?.login ?? ""),
      commitId: String(r.commit_id ?? ""),
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
