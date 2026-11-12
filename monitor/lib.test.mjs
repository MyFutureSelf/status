import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FAILURE_THRESHOLD,
  HISTORY_DAYS,
  applyRun,
  checkOnce,
  checkWithRetries,
  formatDuration,
  recordIssue,
} from "./lib.mjs";

const svc = { id: "web", name: "Website", group: "Website", url: "https://example.test/", expect: "MyFutureSelf" };
const up = { ok: true, httpStatus: 200, latencyMs: 120, error: null, attempts: 1 };
const downResult = { ok: false, httpStatus: 503, latencyMs: 90, error: "HTTP 503", attempts: 3 };
const run = (prev, result, now) => applyRun(prev, [svc], new Map([["web", result]]), now);

function fakeFetch(status, body) {
  return async () => ({ status, text: async () => body });
}

test("a 2xx page with the expected text is up", async () => {
  const r = await checkOnce(svc, { fetchImpl: fakeFetch(200, "<title>MyFutureSelf</title>") });
  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, 200);
});

test("an error status, missing text, a thrown error and a timeout are all down", async () => {
  assert.equal((await checkOnce(svc, { fetchImpl: fakeFetch(500, "MyFutureSelf") })).error, "HTTP 500");
  assert.match((await checkOnce(svc, { fetchImpl: fakeFetch(200, "Parked domain") })).error, /did not contain/);
  const refused = await checkOnce(svc, {
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  assert.deepEqual([refused.ok, refused.error], [false, "ECONNREFUSED"]);
  const slow = await checkOnce(svc, {
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        // AbortSignal.timeout's timer does not hold the event loop open; this one does.
        const hang = setTimeout(() => {}, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(hang);
          reject(signal.reason);
        });
      }),
  });
  assert.deepEqual([slow.ok, slow.error], [false, "No response within 0.02s"]);
});

test("a check retries a failure and stops at the first success", async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? { status: 502, text: async () => "" } : { status: 200, text: async () => "MyFutureSelf" });
  const r = await checkWithRetries(svc, { fetchImpl: flaky, sleep: async () => {} });
  assert.deepEqual([r.ok, r.attempts, calls], [true, 2, 2]);
  calls = 0;
  const dead = await checkWithRetries(svc, { fetchImpl: async () => (calls++, { status: 503, text: async () => "" }), sleep: async () => {} });
  assert.deepEqual([dead.ok, dead.attempts, calls], [false, 3, 3]);
});

test("one failed run is not an outage; two in a row open one; a success resolves it", () => {
  assert.equal(FAILURE_THRESHOLD, 2);
  let { state } = run(null, up, "2026-11-12T10:00:00.000Z");
  assert.equal(state.services[0].status, "up");

  ({ state } = run(state, downResult, "2026-11-12T10:05:00.000Z"));
  assert.equal(state.services[0].status, "up");
  assert.equal(state.services[0].consecutiveFailures, 1);
  assert.equal(state.incidents.length, 0);

  ({ state } = run(state, downResult, "2026-11-12T10:10:00.000Z"));
  assert.equal(state.services[0].status, "down");
  assert.deepEqual(state.services[0].openIncident, { startedAt: "2026-11-12T10:05:00.000Z", issue: null });
  assert.equal(state.incidents.length, 1);
  recordIssue(state, "web", 7);
  assert.equal(state.services[0].openIncident.issue, 7);
  assert.equal(state.incidents[0].issue, 7);

  let resolved;
  ({ state } = run(state, downResult, "2026-11-12T10:15:00.000Z"));
  assert.equal(state.incidents.length, 1, "a continuing outage is still one incident");
  ({ state, resolved } = run(state, up, "2026-11-12T10:20:00.000Z"));
  assert.equal(state.services[0].status, "up");
  assert.equal(state.services[0].openIncident, null);
  assert.deepEqual(resolved, [{ serviceId: "web", startedAt: "2026-11-12T10:05:00.000Z", issue: 7 }]);
  assert.equal(state.incidents[0].resolvedAt, "2026-11-12T10:20:00.000Z");
  assert.deepEqual(state.services[0].days, [{ date: "2026-11-12", checks: 5, ok: 2 }]);
});

test("a single failure between successes never opens an incident", () => {
  let { state } = run(null, up, "2026-11-12T10:00:00.000Z");
  ({ state } = run(state, downResult, "2026-11-12T10:05:00.000Z"));
  const { state: next, resolved } = run(state, up, "2026-11-12T10:10:00.000Z");
  assert.deepEqual([next.incidents.length, resolved.length, next.services[0].consecutiveFailures], [0, 0, 0]);
});

test("daily buckets roll by UTC date and keep 90 days", () => {
  let state = null;
  const start = Date.parse("2026-08-01T12:00:00.000Z");
  for (let day = 0; day < 100; day++) {
    ({ state } = run(state, up, new Date(start + day * 86_400_000).toISOString()));
  }
  const days = state.services[0].days;
  assert.equal(days.length, HISTORY_DAYS);
  assert.equal(days.at(-1).date, "2026-11-08");
  assert.equal(days[0].date, "2026-08-11");
});

test("a service dropped from the config leaves the state with its incidents", () => {
  let { state } = run(null, downResult, "2026-11-12T10:00:00.000Z");
  ({ state } = run(state, downResult, "2026-11-12T10:05:00.000Z"));
  const other = { ...svc, id: "other" };
  const { state: next } = applyRun(state, [other], new Map([["other", up]]), "2026-11-12T10:10:00.000Z");
  assert.deepEqual(next.services.map((s) => s.id), ["other"]);
  assert.deepEqual(next.incidents, []);
});

test("durations read in hours and minutes", () => {
  assert.equal(formatDuration(30_000), "under 1m");
  assert.equal(formatDuration(45 * 60_000), "45m");
  assert.equal(formatDuration((3 * 60 + 12) * 60_000), "3h 12m");
});

test("every configured service is a public https page with a stable id", () => {
  const { services } = JSON.parse(readFileSync(new URL("./services.json", import.meta.url), "utf8"));
  const ids = services.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of services) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.equal(new URL(s.url).protocol, "https:");
    assert.ok(s.name && s.group && s.expect, s.id);
    assert.doesNotMatch(s.url, /\/api\//, "no API routes: they can cost money per call");
  }
});
