// Backstop scheduler for the provisoire slot checker.
//
// GitHub Actions `schedule` events slip by ~1h or drop ticks entirely
// (observed: 10:00/12:00/16:00 UTC ticks never fired), while Cloudflare Cron
// Triggers are punctual. Every 2h this fires POST /api/dispatch on
// provisoire-slots, which starts the provisoire-check.yml workflow via the
// GitHub API. The workflow itself night-gates (full sweep 05:00-20:00 Kigali
// only) and serializes through a concurrency group, so extra or night-time
// dispatches are harmless no-ops.
//
// Cron (set via API, not here): 0 5-19/2 * * *  (05,07,...,19 UTC =
// 07:00-21:00 Kigali, interleaved 1h after GitHub's even-hour ticks).

const DISPATCH_URL = 'https://provisoire-slots.ndatimanah.workers.dev/api/dispatch';

async function dispatch() {
  const r = await fetch(DISPATCH_URL, { method: 'POST' });
  if (!r.ok) throw new Error('dispatch ' + r.status);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatch().catch((e) => console.log('dispatch fail: ' + String((e && e.message) || e))),
    );
  },
  async fetch() {
    return new Response('provisoire dispatch cron: ok', {
      headers: { 'content-type': 'text/plain;charset=utf-8' },
    });
  },
};
