import jwt from "jsonwebtoken";
import type { CookieOptions } from "express";
import { getMcpSessionSecret } from "../auth/secret.js";

/**
 * The browser-facing demo session: proof that a viewer entered DEMO_PASSWORD. It is a signed JWT
 * cookie (HS256) with its OWN audience, distinct from the MCP token's "trock-mcp" audience — the
 * two token families can never be mistaken for one another even though they share a signing secret.
 * httpOnly, so the browser holds it but JS can't read it.
 */
export const DEMO_SESSION_COOKIE = "trock_ai_demo_session";
const DEMO_SESSION_AUDIENCE = "trock-ai-demo-session";

/** A human login session — hours, not the 300s machine token. */
export const DEMO_SESSION_TTL_SECONDS = 60 * 60 * 12;

export function signDemoSession(): string {
  return jwt.sign({ demo: true }, getMcpSessionSecret(), {
    algorithm: "HS256",
    audience: DEMO_SESSION_AUDIENCE,
    expiresIn: DEMO_SESSION_TTL_SECONDS,
  });
}

export function isValidDemoSession(token: string | undefined): boolean {
  if (!token) return false;
  try {
    jwt.verify(token, getMcpSessionSecret(), {
      audience: DEMO_SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}

export function demoSessionCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: DEMO_SESSION_TTL_SECONDS * 1000,
  };
}
