import { describe, expect, it } from "vitest";
import {
  commitsMentionedByBot,
  decideReviewVerdict,
  isReviewBot,
  sameCommit,
  type ReviewGateInput,
} from "./review-findings-gate.js";

/**
 * Every fixture below is a REAL shape observed on this repo on 2026-09-18, not an invented one — the
 * abbreviation lengths, the two summary layouts, the bot's two login spellings. The incident this gate
 * exists for (#1144) is reproduced verbatim as its own case.
 */
const BOT = "chatgpt-codex-connector";
const BOT_APP = "chatgpt-codex-connector[bot]";
const HEAD = "0ab0258f8a1b2c3d4e5f60718293a4b5c6d7e8f9";

function input(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return { headSha: HEAD, reviews: [], reactions: [], comments: [], ...overrides };
}

/** The summary layout carrying an explicit "Reviewed commit" line (10 chars). */
function summaryReviewedCommit(sha: string) {
  return { user: BOT_APP, body: `### 💡 Codex Review\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n` };
}

/** The other layout: a status table abbreviating to 7 chars. */
function summaryTable(sha: string) {
  return {
    user: BOT_APP,
    body: `## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** | \`${sha.slice(0, 7)}\` | New commits |\n`,
  };
}

describe("decideReviewVerdict", () => {
  it("BLOCKS when the bot filed a review against the head commit", () => {
    const result = decideReviewVerdict(input({ reviews: [{ user: BOT, commitId: HEAD }] }));
    expect(result.verdict).toBe("findings");
  });

  it("ALLOWS a 👍 corroborated by a summary naming the head commit", () => {
    const result = decideReviewVerdict(
      input({ reactions: [{ user: BOT_APP, content: "+1" }], comments: [summaryReviewedCommit(HEAD)] })
    );
    expect(result.verdict).toBe("clean");
  });

  it("accepts the 7-char table layout as well as the 10-char line", () => {
    const result = decideReviewVerdict(
      input({ reactions: [{ user: BOT_APP, content: "+1" }], comments: [summaryTable(HEAD)] })
    );
    expect(result.verdict).toBe("clean");
  });

  // THE LOAD-BEARING CASE. A reaction carries no commit, so it survives a later push.
  it("BLOCKS a 👍 left over from an earlier tip", () => {
    const result = decideReviewVerdict(
      input({
        reactions: [{ user: BOT_APP, content: "+1" }],
        comments: [summaryReviewedCommit("deadbeef00112233445566778899aabbccddeeff")],
      })
    );
    expect(result.verdict).toBe("not-reviewed");
    expect(result.reason).toMatch(/left over from an earlier push/);
  });

  it("BLOCKS when nothing has reviewed the PR at all", () => {
    expect(decideReviewVerdict(input()).verdict).toBe("not-reviewed");
  });

  it("BLOCKS when the bot has only acknowledged it (👀), not ruled", () => {
    const result = decideReviewVerdict(
      input({ reactions: [{ user: BOT_APP, content: "eyes" }], comments: [summaryReviewedCommit(HEAD)] })
    );
    expect(result.verdict).toBe("not-reviewed");
  });

  it("findings on the head OUTRANK a stale 👍 — the objection is the newer fact", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [{ user: BOT, commitId: HEAD }],
        reactions: [{ user: BOT_APP, content: "+1" }],
        comments: [summaryReviewedCommit(HEAD)],
      })
    );
    expect(result.verdict).toBe("findings");
  });

  it("ignores reviews filed against OTHER commits — those were addressed by pushing", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [
          { user: BOT, commitId: "1111111111111111111111111111111111111111" },
          { user: BOT, commitId: "2222222222222222222222222222222222222222" },
        ],
        reactions: [{ user: BOT_APP, content: "+1" }],
        comments: [summaryReviewedCommit(HEAD)],
      })
    );
    expect(result.verdict).toBe("clean");
  });

  it("ignores humans and other bots entirely", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [{ user: "coderabbitai[bot]", commitId: HEAD }, { user: "a-person", commitId: HEAD }],
        reactions: [{ user: "greptile-apps[bot]", content: "+1" }],
        comments: [{ user: "a-person", body: `looks good, ${HEAD}` }],
      })
    );
    // A human's 👍 and a CodeRabbit review are both irrelevant to THIS gate's question.
    expect(result.verdict).toBe("not-reviewed");
  });

  /**
   * PR #1144, reconstructed from what the API actually returned: four inline findings filed against the
   * head commit, every check green, mergeable/CLEAN. It merged. This gate is the thing that would have
   * said no.
   */
  it("would have blocked the #1144 merge", () => {
    const pr1144Head = "f406d8f73aa11bb22cc33dd44ee55ff667788990";
    const result = decideReviewVerdict({
      headSha: pr1144Head,
      reviews: [{ user: BOT, commitId: pr1144Head }],
      reactions: [],
      comments: [summaryReviewedCommit(pr1144Head)],
    });
    expect(result.verdict).toBe("findings");
    expect(result.reason).toMatch(/unresolved findings/);
  });
});

describe("sameCommit", () => {
  it("matches an abbreviation against a full SHA, in either direction", () => {
    expect(sameCommit(HEAD, HEAD.slice(0, 7))).toBe(true);
    expect(sameCommit(HEAD.slice(0, 10), HEAD)).toBe(true);
  });

  it("does not match different commits that share a short prefix", () => {
    expect(sameCommit("0ab0258f8a", "0ab0258f9b")).toBe(false);
  });

  it("refuses anything too short to be meaningful rather than matching loosely", () => {
    expect(sameCommit(HEAD, "0ab025")).toBe(false);
    expect(sameCommit(HEAD, "")).toBe(false);
  });
});

describe("commitsMentionedByBot", () => {
  it("reads both summary layouts and ignores non-bot comments", () => {
    const found = commitsMentionedByBot([
      summaryReviewedCommit(HEAD),
      summaryTable("1234567890abcdef1234567890abcdef12345678"),
      { user: "a-person", body: "see cafebabe1234" },
    ]);
    expect(found).toContain(HEAD.slice(0, 10));
    expect(found).toContain("1234567");
    expect(found).not.toContain("cafebabe1234");
  });
});

describe("isReviewBot", () => {
  it("recognises both login spellings the surfaces use", () => {
    expect(isReviewBot(BOT)).toBe(true);
    expect(isReviewBot(BOT_APP)).toBe(true);
    expect(isReviewBot("coderabbitai[bot]")).toBe(false);
    expect(isReviewBot("greptile-apps[bot]")).toBe(false);
  });
});
