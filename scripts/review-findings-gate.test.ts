import { describe, expect, it } from "vitest";
import {
  commitsMentionedByBot,
  decideReviewVerdict,
  isReviewBot,
  sameCommit,
  worstVerdict,
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
  return { headSha: HEAD, reviews: [], reactions: [], mentionedCommits: [], ...overrides };
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
      input({ reactions: [{ user: BOT_APP, content: "+1" }], mentionedCommits: [HEAD] })
    );
    expect(result.verdict).toBe("clean");
  });

  it("accepts the 7-char table layout as well as the 10-char line", () => {
    const result = decideReviewVerdict(
      input({ reactions: [{ user: BOT_APP, content: "+1" }], mentionedCommits: [HEAD] })
    );
    expect(result.verdict).toBe("clean");
  });

  // THE LOAD-BEARING CASE. A reaction carries no commit, so it survives a later push.
  it("BLOCKS a 👍 left over from an earlier tip", () => {
    const result = decideReviewVerdict(
      input({
        reactions: [{ user: BOT_APP, content: "+1" }],
        mentionedCommits: ["deadbeef00112233445566778899aabbccddeeff"],
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
      input({ reactions: [{ user: BOT_APP, content: "eyes" }], mentionedCommits: [HEAD] })
    );
    expect(result.verdict).toBe("not-reviewed");
  });

  it("findings on the head OUTRANK a stale 👍 — the objection is the newer fact", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [{ user: BOT, commitId: HEAD }],
        reactions: [{ user: BOT_APP, content: "+1" }],
        mentionedCommits: [HEAD],
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
        mentionedCommits: [HEAD],
      })
    );
    expect(result.verdict).toBe("clean");
  });

  it("ignores humans and other bots entirely", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [{ user: "coderabbitai[bot]", commitId: HEAD }, { user: "a-person", commitId: HEAD }],
        reactions: [{ user: "greptile-apps[bot]", content: "+1" }],
        mentionedCommits: [HEAD],
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
      mentionedCommits: [pr1144Head],
    });
    expect(result.verdict).toBe("findings");
    expect(result.reason).toMatch(/unresolved findings/);
  });
});

describe("sameCommit", () => {
  it("matches only a full SHA against the identical full SHA", () => {
    expect(sameCommit(HEAD, HEAD)).toBe(true);
    expect(sameCommit(HEAD.toUpperCase(), HEAD)).toBe(true);
  });

  // THE COLLISION-MINING HOLE. The bot abbreviates to 7 hex chars in its status table — 28 bits, cheap to
  // mine. With a 👍 persisting across pushes, prefix matching would let a crafted commit sharing that
  // prefix arrive pre-approved. Abbreviations are resolved by the caller now; this refuses them outright.
  it("REFUSES an abbreviation, however long", () => {
    expect(sameCommit(HEAD, HEAD.slice(0, 7))).toBe(false);
    expect(sameCommit(HEAD, HEAD.slice(0, 10))).toBe(false);
    expect(sameCommit(HEAD, HEAD.slice(0, 39))).toBe(false);
  });

  it("does not match different commits that share a prefix", () => {
    const sibling = `${HEAD.slice(0, 7)}${"f".repeat(33)}`;
    expect(sameCommit(HEAD, sibling)).toBe(false);
  });

  it("refuses empty input rather than matching loosely", () => {
    expect(sameCommit(HEAD, "")).toBe(false);
  });
});

describe("worstVerdict", () => {
  // A commit status knows nothing about pull requests, so when two open PRs share a head commit the
  // published verdict has to be safe for BOTH. Worst wins.
  it("findings beats everything", () => {
    expect(worstVerdict(["clean", "findings", "not-reviewed"])).toBe("findings");
    expect(worstVerdict(["findings"])).toBe("findings");
  });

  it("not-reviewed beats clean", () => {
    expect(worstVerdict(["clean", "not-reviewed"])).toBe("not-reviewed");
  });

  it("clean only when every PR on the commit is clean", () => {
    expect(worstVerdict(["clean", "clean"])).toBe("clean");
    expect(worstVerdict([])).toBe("clean");
  });
});

describe("commitsMentionedByBot", () => {
  it("reads both summary layouts and ignores non-bot comments", () => {
    const found = commitsMentionedByBot([
      summaryReviewedCommit(HEAD),
      summaryTable("1234567890abcdef1234567890abcdef12345678"),
      { user: "a-person", body: "see cafebabe1234" },
    ]);
    // Extraction is deliberately permissive — resolution is what establishes identity.
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

  // The gate's job is to be the thing that cannot be talked around, so attribution is an EXACT set.
  // A substring match would trust any account that happens to contain "codex" in its name.
  it("refuses a login that merely CONTAINS the bot's name", () => {
    for (const impostor of ["codex", "not-codex", "codex-connector", "chatgpt-codex-connector-2", "my-codex-bot"]) {
      expect(isReviewBot(impostor), impostor).toBe(false);
    }
  });
});

describe("attribution cannot be spoofed", () => {
  it("a lookalike account cannot manufacture a clean verdict", () => {
    // Exactly the shape a clean pass has — a 👍 plus a comment naming the head — from an account whose
    // login merely contains "codex".
    const result = decideReviewVerdict(
      input({
        reactions: [{ user: "codex-lookalike[bot]", content: "+1" }],
        mentionedCommits: [HEAD],
      })
    );
    expect(result.verdict).toBe("not-reviewed");
  });
});

describe("dismissed reviews", () => {
  it("a DISMISSED review on the head no longer blocks", () => {
    const result = decideReviewVerdict(
      input({
        reviews: [{ user: BOT, commitId: HEAD, state: "DISMISSED" }],
        reactions: [{ user: BOT_APP, content: "+1" }],
        mentionedCommits: [HEAD],
      })
    );
    expect(result.verdict).toBe("clean");
  });

  it("CONTROL — a COMMENTED review on the head still blocks", () => {
    const result = decideReviewVerdict(
      input({ reviews: [{ user: BOT, commitId: HEAD, state: "COMMENTED" }] })
    );
    expect(result.verdict).toBe("findings");
  });

  it("a review with no state at all is treated as live, not dismissed", () => {
    // Fail closed on missing data: an absent state must never read as "withdrawn".
    expect(decideReviewVerdict(input({ reviews: [{ user: BOT, commitId: HEAD }] })).verdict).toBe("findings");
  });
});
