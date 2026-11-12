import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FAILURE_THRESHOLD,
  HISTORY_DAYS,
  applyRun,
  checkOnce,
  checkWithRetries,
  combineResults,
  formatDuration,
  parseHosts,
  recordIssue,
  redactHosts,
  targetsFor,
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

test("every configured service is a public https page or a secret host list, with a stable id", () => {
  const { services } = JSON.parse(readFileSync(new URL("./services.json", import.meta.url), "utf8"));
  const ids = services.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of services) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.name && s.group && s.expect, s.id);
    if (s.hostsFrom) {
      assert.equal(s.url, undefined, `${s.id}: a host-list service publishes no url`);
      assert.match(s.hostsFrom, /^[A-Z][A-Z0-9_]*$/);
    } else {
      assert.equal(new URL(s.url).protocol, "https:");
      assert.doesNotMatch(s.url, /\/api\//, "no API routes: they can cost money per call");
    }
  }
  assert.deepEqual(
    services.map((s) => s.name),
    ["myfutureselfapp.com", "Campus product"],
  );
});

test("campus hosts come from the environment, sorted, and a missing list stops the run", () => {
  const campus = { id: "campus", name: "Campus product", group: "Campus", hostsFrom: "CAMPUS_HOSTS", expect: "MyFutureSelf" };
  assert.deepEqual(parseHosts(" b.example.test,\nhttps://A.example.test/ b.example.test "), ["a.example.test", "b.example.test"]);
  assert.throws(() => parseHosts("not a host"), /Not a hostname/);
  assert.deepEqual(
    targetsFor(campus, { CAMPUS_HOSTS: "b.example.test a.example.test" }),
    [
      { url: "https://a.example.test/", expect: "MyFutureSelf", host: "a.example.test" },
      { url: "https://b.example.test/", expect: "MyFutureSelf", host: "b.example.test" },
    ],
  );
  assert.throws(() => targetsFor(campus, {}), /CAMPUS_HOSTS is empty or not set/);
  assert.deepEqual(targetsFor(svc, {}), [{ url: svc.url, expect: svc.expect }]);
});

test("the campus product is up only when every site is up, and its error never names a site", () => {
  const hosts = ["a.example.test", "b.example.test"];
  assert.deepEqual(combineResults([up, { ...up, latencyMs: 300, attempts: 2 }], hosts), {
    ok: true,
    httpStatus: 200,
    latencyMs: 300,
    error: null,
    attempts: 2,
  });
  const leak = { ...downResult, httpStatus: null, error: "getaddrinfo ENOTFOUND b.example.test" };
  const one = combineResults([up, leak], hosts);
  assert.equal(one.ok, false);
  assert.equal(one.error, "1 campus site failed: getaddrinfo ENOTFOUND a campus site");
  assert.equal(combineResults([downResult, downResult], hosts).error, "2 campus sites failed: HTTP 503");
  assert.equal(redactHosts("x a.example.test y", hosts), "x a campus site y");
  assert.equal(combineResults([downResult]), downResult, "a single-page service passes its result through");

  // Folded into the state like any service: one check per run, and the row carries no url.
  const campus = { id: "campus", name: "Campus product", group: "Campus", hostsFrom: "CAMPUS_HOSTS" };
  const { state } = applyRun(null, [campus], new Map([["campus", one]]), "2026-11-12T10:00:00.000Z");
  assert.equal("url" in state.services[0], false);
  assert.deepEqual(state.services[0].days, [{ date: "2026-11-12", checks: 1, ok: 0 }]);
  assert.doesNotMatch(JSON.stringify(state), /example\.test/);
});
