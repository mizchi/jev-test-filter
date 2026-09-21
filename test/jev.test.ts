import { test } from "node:test";
import assert from "node:assert/strict";
import { Jev, JevError, Pacer, mapLimit } from "../src/jev.ts";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("ask posts one state and many questions to /v1/systemone", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const jev = new Jev({
    apiKey: "k",
    pacer: new Pacer(1e9, 1e9),
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return ok({ answers: { q0000: { score: 2, confidence: 0.8 } }, usage: { input_tokens: 10 } });
    },
  });
  const res = await jev.ask({ diff: "x" }, { q0000: { type: "score", instructions: {}, criteria: ["a"] } });
  assert.match(seen[0]!.url, /\/v1\/systemone$/);
  assert.deepEqual((seen[0]!.body as Record<string, unknown>).state, { diff: "x" });
  assert.deepEqual(res.answers, { q0000: { score: 2, confidence: 0.8 } });
  assert.equal(jev.spent.inputTokens, 10);
});

test("ask with no questions makes no request", async () => {
  let calls = 0;
  const jev = new Jev({ apiKey: "k", fetch: async () => { calls += 1; return ok({}); } });
  const res = await jev.ask({}, {});
  assert.equal(calls, 0);
  assert.deepEqual(res.answers, {});
});

test("askSplitting halves the questions on max_tokens_exceeded", async () => {
  const sizes: number[] = [];
  const jev = new Jev({
    apiKey: "k",
    pacer: new Pacer(1e9, 1e9),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
      const n = Object.keys(body.questions).length;
      sizes.push(n);
      if (n > 2) return new Response('{"error":"max_tokens_exceeded"}', { status: 400 });
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { score: 1, confidence: 0.5 }]));
      return ok({ answers, usage: { input_tokens: n } });
    },
  });
  const questions = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [`q${i}`, { type: "score", instructions: {}, criteria: ["a"] }]),
  );
  const res = await jev.askSplitting({}, questions as never);
  assert.deepEqual(Object.keys(res.answers!).sort(), ["q0", "q1", "q2", "q3"]);
  assert.deepEqual(sizes, [4, 2, 2]);
});

test("a 401 is an auth error and is not retried", async () => {
  let calls = 0;
  const jev = new Jev({
    apiKey: "k",
    retries: 3,
    pacer: new Pacer(1e9, 1e9),
    fetch: async () => { calls += 1; return new Response("nope", { status: 401 }); },
  });
  await assert.rejects(
    () => jev.ask({}, { q0: { type: "score", instructions: {}, criteria: ["a"] } }),
    (err: unknown) => err instanceof JevError && err.kind === "auth",
  );
  assert.equal(calls, 1);
});

test("a missing key fails before any request", async () => {
  const jev = new Jev({ apiKey: "", fetch: async () => { throw new Error("should not be called"); } });
  await assert.rejects(
    () => jev.ask({}, { q0: { type: "score", instructions: {}, criteria: ["a"] } }),
    /TYPESAFE_API_KEY/,
  );
});

test("Pacer waits until the bucket can pay and settles to the real count", () => {
  const p = new Pacer(1000, 1000, 0);
  assert.equal(p.delay(500, 0), 0);
  p.take(500);
  assert.equal(p.delay(1000, 0) > 0, true);
  p.settle(500, 100);
  assert.equal(p.available(0), 900);
});

test("Pacer treats a backwards clock as no elapsed time", () => {
  const p = new Pacer(1000, 1000, 1_000_000);
  assert.equal(p.available(999_000), 1000);
});

test("mapLimit preserves input order", async () => {
  const out = await mapLimit([3, 1, 2], 2, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 10;
  });
  assert.deepEqual(out, [30, 10, 20]);
});
