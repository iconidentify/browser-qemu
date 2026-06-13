#!/usr/bin/env node
/*
 * Mint an HS256 admin JWT for the dialtone relay's write endpoints.
 * The relay (68k_web apps/relay, auth.go) checks signature, exp, and
 * isAdmin=true; the secret comes from DIALTONE_JWT_SECRET on both sides.
 *
 * usage: DIALTONE_JWT_SECRET=devsecret node scripts/mint-dialtone-token.mjs [days]
 */
import crypto from "node:crypto";

const secret = process.env.DIALTONE_JWT_SECRET;
if (!secret) {
  console.error("DIALTONE_JWT_SECRET is required");
  process.exit(2);
}

const days = Number(process.argv[2]) || 30;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(JSON.stringify({
  userId: 0,
  providerUsername: "browser-qemu-dev",
  isAdmin: true,
  exp: Math.floor(Date.now() / 1000) + days * 86400,
}));
const signature = crypto
  .createHmac("sha256", secret)
  .update(`${header}.${payload}`)
  .digest("base64url");

console.log(`${header}.${payload}.${signature}`);
