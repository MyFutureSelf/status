// The monitor's pure parts: one HTTP check with retries, and folding a run's
// results into the published state. monitor.mjs does the I/O around them.

/** Consecutive failed runs before a service counts as down and an issue opens. */
export const FAILURE_THRESHOLD = 2;
/** Days of daily buckets the state keeps, today included. */
export const HISTORY_DAYS = 90;
export const TIMEOUT_MS = 10_000;
/** Pauses between the attempts of one run's check (three attempts in all). */
export const RETRY_DELAYS_MS = [5_000, 10_000];
const USER_AGENT =
  "MyFutureSelf-Status-Monitor/1 (+https://myfutureselfapp.com/status)";
const DAY_MS = 86_400_000;

/** @param {string} iso */
export function dayKey(iso) {
  return iso.slice(0, 10);
}

/** One GET of a service. Never throws: a failure comes back as `ok: false` with the reason. */
export async function checkOnce(
  service,
  { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, now = () => performance.now() } = {},
) {
  const started = now();
  const elapsed = () => Math.round(now() - started);
  try {
    const response = await fetchImpl(service.url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const latencyMs = elapsed();
    if (response.status < 200 || response.status >= 400)
      return { ok: false, httpStatus: response.status, latencyMs, error: `HTTP ${response.status}` };
    if (service.expect && !body.includes(service.expect))
      return {
        ok: false,
        httpStatus: response.status,
        latencyMs,
        error: `The page did not contain "${service.expect}"`,
      };
    return { ok: true, httpStatus: response.status, latencyMs, error: null };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ok: false,
      httpStatus: null,
      latencyMs: elapsed(),
      error: timedOut
        ? `No response within ${timeoutMs / 1000}s`
        : String(error?.cause?.code ?? error?.message ?? error),
    };
  }
}

/** Up to three attempts; the first success wins, otherwise the last failure stands. */
export async function checkWithRetries(
  service,
  { delays = RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...options } = {},
) {
  let result = await checkOnce(service, options);
  let attempts = 1;
  for (const delay of delays) {
    if (result.ok) break;
    await sleep(delay);
    result = await checkOnce(service, options);
    attempts += 1;
  }
  return { ...result, attempts };
}

/**
 * The hosts behind a service whose pages come from a secret (`hostsFrom`), so
 * the public repository, status.json and run logs never name them. Accepts
 * hostnames or https URLs separated by commas or whitespace. Sorted, so a log
 * line's "site 3" is the third host in alphabetical order.
 *
 * @param {string | undefined} text
 */
export function parseHosts(text) {
  const hosts = new Set();
  for (const raw of (text ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    const host = (raw.includes("://") ? new URL(raw).hostname : raw).toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error(`Not a hostname (entry ${hosts.size + 1})`);
    hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * The pages one service checks. A plain service has its own `url`; a
 * `hostsFrom` service checks `https://<host>/` for every host in that
 * environment variable and refuses to run without them.
 */
export function targetsFor(service, env = process.env) {
  if (!service.hostsFrom) return [{ url: service.url, expect: service.expect }];
  const hosts = parseHosts(env[service.hostsFrom]);
  if (!hosts.length) throw new Error(`${service.id}: ${service.hostsFrom} is empty or not set`);
  return hosts.map((host) => ({ url: `https://${host}/`, expect: service.expect, host }));
}

/** Replaces every host in `text` with "a campus site", so an error string cannot leak one. */
export function redactHosts(text, hosts) {
  if (!text) return text;
  let out = text;
  for (const host of [...hosts].sort((a, b) => b.length - a.length)) out = out.split(host).join("a campus site");
  return out;
}

/**
 * One result for a service checked on several pages: up only when every page
 * is up. A failure reports how many sites failed and the first failure's
 * error, never which site.
 *
 * @param {Array<{ok: boolean, httpStatus: number | null, latencyMs: number, error: string | null, attempts: number}>} parts
 * @param {string[]} hosts redacted from the error
 */
export function combineResults(parts, hosts = []) {
  if (parts.length === 1 && !hosts.length) return parts[0];
  const failed = parts.filter((p) => !p.ok);
  const latencyMs = Math.max(...parts.map((p) => p.latencyMs));
  const attempts = Math.max(...parts.map((p) => p.attempts));
  if (!failed.length) return { ok: true, httpStatus: parts[0].httpStatus, latencyMs, error: null, attempts };
  const first = failed[0];
  const sites = failed.length === 1 ? "1 campus site" : `${failed.length} campus sites`;
  return {
    ok: false,
    httpStatus: first.httpStatus,
    latencyMs,
    error: `${sites} failed: ${redactHosts(first.error, hosts) ?? "failed"}`,
    attempts,
  };
}

/**
 * Folds one run into the previous state. Pure: returns the next state and the
 * incidents this run resolved (the caller comments on and closes their issues).
 *
 * @param {object | null} previous the last published status.json, or null
 * @param {Array<{id: string, name: string, group: string, url?: string}>} services
 * @param {Map<string, {ok: boolean}>} results this run's result per service id
 * @param {string} now ISO time of the run
 */
export function applyRun(previous, services, results, now) {
  const prev = previous?.version === 1 ? previous : { services: [], incidents: [] };
  const prevById = new Map(prev.services.map((s) => [s.id, s]));
  const ids = new Set(services.map((s) => s.id));
  const today = dayKey(now);
  const cutoff = dayKey(new Date(Date.parse(now) - (HISTORY_DAYS - 1) * DAY_MS).toISOString());
  const incidents = (prev.incidents ?? [])
    .filter((i) => ids.has(i.serviceId))
    .map((i) => ({ ...i }));
  const resolved = [];

  const nextServices = services.map((service) => {
    const old = prevById.get(service.id);
    const result = results.get(service.id);
    if (!result) throw new Error(`No result for ${service.id}`);

    const days = (old?.days ?? []).filter((d) => d.date >= cutoff).map((d) => ({ ...d }));
    let bucket = days.find((d) => d.date === today);
    if (!bucket) {
      bucket = { date: today, checks: 0, ok: 0 };
      days.push(bucket);
    }
    bucket.checks += 1;
    if (result.ok) bucket.ok += 1;
    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const consecutiveFailures = result.ok ? 0 : (old?.consecutiveFailures ?? 0) + 1;
    const failingSince = result.ok ? null : (old?.failingSince ?? now);
    let openIncident = old?.openIncident ?? null;

    if (!result.ok && !openIncident && consecutiveFailures >= FAILURE_THRESHOLD) {
      openIncident = { startedAt: failingSince, issue: null };
      incidents.push({ serviceId: service.id, startedAt: failingSince, resolvedAt: null, issue: null });
    } else if (result.ok && openIncident) {
      const incident = incidents.findLast((i) => i.serviceId === service.id && !i.resolvedAt);
      if (incident) incident.resolvedAt = now;
      resolved.push({ serviceId: service.id, startedAt: openIncident.startedAt, issue: openIncident.issue });
      openIncident = null;
    }

    return {
      id: service.id,
      name: service.name,
      group: service.group,
      ...(service.url ? { url: service.url } : {}),
      status: openIncident ? "down" : "up",
      lastCheck: { at: now, ...result },
      consecutiveFailures,
      failingSince,
      openIncident,
      days,
    };
  });

  return {
    state: {
      version: 1,
      updatedAt: now,
      intervalMinutes: 5,
      services: nextServices,
      incidents: incidents
        .filter((i) => !i.resolvedAt || dayKey(i.resolvedAt) >= cutoff)
        .slice(-50),
    },
    resolved,
  };
}

/** Records an opened issue's number on the service and its open incident. Mutates `state`. */
export function recordIssue(state, serviceId, issue) {
  const service = state.services.find((s) => s.id === serviceId);
  if (service?.openIncident) service.openIncident.issue = issue;
  const incident = state.incidents.findLast((i) => i.serviceId === serviceId && !i.resolvedAt);
  if (incident) incident.issue = issue;
}

/** "3h 12m", "45m", "under 1m" */
export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
