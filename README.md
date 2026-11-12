# MyFutureSelf status

Uptime checks for MyFutureSelf's public sites, shown at https://myfutureselfapp.com/status.

- `monitor/services.json` lists what is checked: read-only GETs of public pages, no auth.
- `.github/workflows/monitor.yml` runs the checks about every 5 minutes. Each check gets three attempts with a 10-second timeout, and a page counts as up when it answers 2xx or 3xx and contains its expected text.
- Results live as the only commit on the `status-data` branch: [`status.json`](https://raw.githubusercontent.com/MyFutureSelf/status/status-data/status.json). It holds each service's last check, 90 days of daily check counts, and recent incidents. Days are UTC.
- Two failed runs in a row open an issue labelled `outage`. The first good run comments on it and closes it.

Tests: `node --test monitor/*.test.mjs`. Run one check locally: `node monitor/monitor.mjs none /tmp/status.json`.
