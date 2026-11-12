// One monitor run: check every service, fold the results into the previous
// state, open or close outage issues, and write the new status.json.
//
//   node monitor/monitor.mjs <previous status.json or "none"> <output path>
//
// Issues go to ISSUES_REPO (default: this repository) with ISSUES_TOKEN
// (default: the workflow's GITHUB_TOKEN). Without a token the run still writes
// the state and only logs what it would have filed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  applyRun,
  checkWithRetries,
  combineResults,
  formatDuration,
  recordIssue,
  redactHosts,
  targetsFor,
} from "./lib.mjs";

const [previousPath, outputPath] = process.argv.slice(2);
if (!previousPath || !outputPath) {
  console.error("usage: node monitor/monitor.mjs <previous.json|none> <output.json>");
  process.exit(2);
}

// SERVICES_FILE swaps the list, for an end-to-end test of the issue flow.
const servicesFile = process.env.SERVICES_FILE || new URL("./services.json", import.meta.url);
const { services } = JSON.parse(readFileSync(servicesFile, "utf8"));
let previous = null;
if (previousPath !== "none" && existsSync(previousPath)) {
  try {
    previous = JSON.parse(readFileSync(previousPath, "utf8"));
  } catch (error) {
    console.warn(`::warning::Previous state unreadable, starting fresh: ${error.message}`);
  }
}

// A service with `hostsFrom` (the campus product) checks every host in that
// secret. The hosts are never printed: this repository and its run logs are
// public. Each one is also registered as a mask, so the runner redacts it if
// anything ever does print it.
const targets = new Map(services.map((s) => [s.id, targetsFor(s)]));
const hiddenHosts = [...targets.values()].flat().flatMap((t) => (t.host ? [t.host] : []));
if (process.env.GITHUB_ACTIONS) for (const host of hiddenHosts) console.log(`::add-mask::${host}`);

const now = new Date().toISOString();
const results = new Map(
  await Promise.all(
    services.map(async (s) => {
      const parts = await Promise.all(targets.get(s.id).map((t) => checkWithRetries({ ...s, ...t })));
      return [s.id, { parts, combined: combineResults(parts, s.hostsFrom ? hiddenHosts : []) }];
    }),
  ),
);
for (const s of services) {
  const { parts, combined: r } = results.get(s.id);
  const sites = s.hostsFrom ? ` ${parts.filter((p) => p.ok).length}/${parts.length} sites up` : "";
  console.log(
    `${r.ok ? "up  " : "DOWN"} ${s.id}${sites} ${r.httpStatus ?? "-"} ${r.latencyMs}ms attempts=${r.attempts}${r.error ? ` ${r.error}` : ""}`,
  );
  // Failed sites by position in the sorted host list, so the log can be traced
  // privately against the secret without naming a school here.
  if (s.hostsFrom)
    parts.forEach((p, index) => {
      if (!p.ok)
        console.log(
          `     site ${index + 1}: ${p.httpStatus ?? "-"} ${p.latencyMs}ms attempts=${p.attempts} ${redactHosts(p.error, hiddenHosts)}`,
        );
    });
}

const { state, resolved } = applyRun(
  previous,
  services,
  new Map([...results].map(([id, r]) => [id, r.combined])),
  now,
);

// Outage issues. A failure here never loses the state: the open incident keeps
// `issue: null` and the next run tries again.
const token = process.env.ISSUES_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.ISSUES_REPO || process.env.GITHUB_REPOSITORY;
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;
const LABEL = "outage";

async function gh(method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && !(method === "POST" && path === "/labels" && response.status === 422))
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const titleFor = (service) => `Outage: ${service.name}`;

async function openIssues() {
  return gh("GET", `/issues?labels=${LABEL}&state=open&per_page=100`);
}

if (!token || !repo) {
  console.log("No issues token or repository; skipping outage issues.");
} else {
  try {
    const down = state.services.filter((s) => s.openIncident && !s.openIncident.issue);
    if (down.length || resolved.length) {
      await gh("POST", "/labels", {
        name: LABEL,
        color: "b60205",
        description: "Opened and closed by the status monitor",
      });
      const open = await openIssues();
      for (const service of down) {
        const last = service.lastCheck;
        const lines = [
          `${service.name} failed ${service.consecutiveFailures} checks in a row, starting ${service.openIncident.startedAt}.`,
          "",
          `Last check at ${last.at}: ${last.error ?? "failed"}, after ${last.attempts} attempts.`,
          ...(runUrl ? ["", `Run: ${runUrl}`] : []),
          "",
          "The monitor comments and closes this issue when the service answers again.",
        ];
        const existing = open.find((i) => i.title === titleFor(service));
        let number;
        if (existing) {
          number = existing.number;
          await gh("POST", `/issues/${number}/comments`, { body: `Down again.\n\n${lines.join("\n")}` });
        } else {
          number = (await gh("POST", "/issues", { title: titleFor(service), body: lines.join("\n"), labels: [LABEL] }))
            .number;
        }
        recordIssue(state, service.id, number);
        console.log(`Outage issue #${number} for ${service.id}`);
      }
      for (const event of resolved) {
        const service = state.services.find((s) => s.id === event.serviceId);
        const number = event.issue ?? open.find((i) => i.title === titleFor(service))?.number;
        if (!number) continue;
        const lasted = formatDuration(Date.parse(now) - Date.parse(event.startedAt));
        await gh("POST", `/issues/${number}/comments`, {
          body: `Recovered at ${now}: ${service.name} is up again. Down for ${lasted}.${runUrl ? `\n\nRun: ${runUrl}` : ""}`,
        });
        await gh("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
        console.log(`Closed outage issue #${number} for ${service.id}`);
      }
    }
  } catch (error) {
    console.log(`::warning::Outage issue update failed: ${error.message}`);
  }
}

writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`);
console.log(`Wrote ${outputPath}: ${state.services.filter((s) => s.status === "down").length} down`);
