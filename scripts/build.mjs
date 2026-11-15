// Refreshes the moving parts of the profile page:
//   assets/stats-dark.svg, assets/stats-light.svg   a terminal-style card: numbers, a year of contributions, languages
//   README.md between the POSTS and ACTIVITY markers   latest posts from otis.zone, recent public GitHub activity
//
// No dependencies and no third-party service: it reads GitHub's own API and otis.zone's RSS feed, and writes files
// into this repository. Runs in GitHub Actions (.github/workflows/refresh.yml) and locally:
//   GITHUB_TOKEN=… node scripts/build.mjs
import { readFileSync, writeFileSync } from "node:fs";

const LOGIN = process.env.LOGIN || "otistruong";
const TOKEN = process.env.GITHUB_TOKEN;
const FEED = process.env.FEED || "https://otis.zone/rss.xml";
if (!TOKEN) throw new Error("GITHUB_TOKEN is not set");

const headers = { Authorization: `Bearer ${TOKEN}`, "User-Agent": `${LOGIN}-profile`, Accept: "application/vnd.github+json" };

// ---- data ---------------------------------------------------------------------------------------------------------

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GitHub GraphQL: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

const { user } = await graphql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      followers { totalCount }
      repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, orderBy: { field: STARGAZERS, direction: DESC }) {
        totalCount
        nodes { stargazerCount languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
      }
      contributionsCollection {
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      }
    }
  }`,
  { login: LOGIN },
);

const repos = user.repositories.nodes;
const stars = repos.reduce((n, r) => n + r.stargazerCount, 0);
const calendar = user.contributionsCollection.contributionCalendar;
const days = calendar.weeks.flatMap((w) => w.contributionDays);

// Streaks. Today not having a contribution yet doesn't break the current streak.
let longest = 0;
let run = 0;
for (const d of days) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  longest = Math.max(longest, run);
}
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue;
  else break;
}

// The busiest day. Totals of commits or pull requests would leave out private work, which the calendar includes.
const best = days.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), days[0]);

// Shades by quartile of the days with any contribution, as GitHub does: one huge day doesn't wash out the rest.
const active = days.map((d) => d.contributionCount).filter((n) => n > 0).sort((a, b) => a - b);
const quart = [0.25, 0.5, 0.75].map((q) => active[Math.floor(q * (active.length - 1))] ?? 1);

// Languages by bytes across public repositories. Markup and config are left out: they say little about the work.
const SKIP = new Set(["HTML", "CSS", "SCSS", "Dockerfile", "Makefile", "Shell", "Procfile", "MDX"]);
const bytes = new Map();
for (const r of repos) for (const e of r.languages.edges) if (!SKIP.has(e.node.name)) bytes.set(e.node.name, (bytes.get(e.node.name) ?? 0) + e.size);
const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
const languages = [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, size]) => ({ name, share: size / total }));

// Recent public activity, newest first, one line per thing done.
async function activity() {
  const res = await fetch(`https://api.github.com/users/${LOGIN}/events/public?per_page=60`, { headers });
  if (!res.ok) return [];
  const events = await res.json();
  const lines = [];
  const link = (repo) => `[${repo.replace(`${LOGIN}/`, "")}](https://github.com/${repo})`;
  for (const e of events) {
    const repo = e.repo.name;
    const p = e.payload ?? {};
    let text = null;
    if (e.type === "PushEvent") {
      const n = p.size ?? p.commits?.length ?? 0;
      if (n === 0) continue;
      const last = lines.at(-1);
      // consecutive pushes to one repository read better as one line
      if (last?.repo === repo && last.kind === "push") {
        last.count += n;
        last.text = `pushed ${last.count} commits to ${link(repo)}`;
        continue;
      }
      lines.push({ repo, kind: "push", count: n, date: e.created_at, text: `pushed ${n} commit${n === 1 ? "" : "s"} to ${link(repo)}` });
      continue;
    }
    if (e.type === "CreateEvent" && p.ref_type === "repository") text = `created ${link(repo)}`;
    if (e.type === "ReleaseEvent" && p.action === "published") text = `released [${p.release.tag_name}](${p.release.html_url}) of ${link(repo)}`;
    if (e.type === "PullRequestEvent" && ["opened", "closed"].includes(p.action))
      text = `${p.action === "closed" && p.pull_request.merged ? "merged" : p.action} [#${p.pull_request.number}](${p.pull_request.html_url}) in ${link(repo)}`;
    if (e.type === "IssuesEvent" && p.action === "opened") text = `opened [#${p.issue.number}](${p.issue.html_url}) in ${link(repo)}`;
    if (e.type === "WatchEvent") text = `starred ${link(repo)}`;
    if (e.type === "ForkEvent") text = `forked ${link(repo)}`;
    if (text) lines.push({ repo, kind: e.type, date: e.created_at, text });
  }
  return lines.slice(0, 5);
}

// Latest posts from the site's RSS feed. A feed that can't be read leaves the list as it was.
async function posts() {
  try {
    const res = await fetch(FEED, { headers: { "User-Agent": `${LOGIN}-profile` } });
    if (!res.ok) return null;
    const xml = await res.text();
    const tag = (item, name) => item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? "";
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4).map(([, item]) => ({ title: decode(tag(item, "title")), link: tag(item, "link"), date: new Date(tag(item, "pubDate")) }));
  } catch {
    return null;
  }
}
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// ---- the card -----------------------------------------------------------------------------------------------------

// The Midnight and Paper themes of otis.zone's design system, the same colours as the banner and project cards.
const THEMES = {
  dark: { bg: "#121214", line: "#2a2a2d", fg: "#e9e5dc", fg2: "#a6a299", fg3: "#7d7a72", accent: "#c9f53a", empty: "#1f1f22", ramp: ["#3a4a17", "#5e7d1f", "#93bd2c", "#c9f53a"] },
  light: { bg: "#fbf9f4", line: "#d9d5ca", fg: "#1b1a17", fg2: "#56534b", fg3: "#69655c", accent: "#1f7a3d", empty: "#ece8df", ramp: ["#b6d7bf", "#77b089", "#3f8f57", "#1f7a3d"] },
};
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => n.toLocaleString("en-US");

function card(t) {
  const W = 840;
  const pad = 24;
  const out = [];
  const text = (x, y, s, fill, size = 12, extra = "") => out.push(`<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`);

  // prompt line, like the terminal on otis.zone
  text(pad, 38, "otis@github", t.accent, 12.5);
  text(pad + 92, 38, `~ % gh stats ${LOGIN}`, t.fg2, 12.5);

  // the numbers, four across
  const stats = [
    ["contributions", num(calendar.totalContributions), "in the last year"],
    ["current streak", `${current} day${current === 1 ? "" : "s"}`, `longest ${longest}`],
    ["public repos", num(user.repositories.totalCount), `${num(stars)} star${stars === 1 ? "" : "s"}`],
    ["busiest day", num(best.contributionCount), best.contributionCount ? new Date(best.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).toLowerCase() : "not yet"],
  ];
  const colW = (W - pad * 2) / 4;
  stats.forEach(([label, value, note], i) => {
    const x = pad + i * colW;
    text(x, 74, label.toUpperCase(), t.fg3, 10, ' letter-spacing="1.4"');
    out.push(`<text x="${x}" y="102" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="24" font-weight="700" letter-spacing="-0.5" fill="${t.fg}">${esc(value)}</text>`);
    text(x, 120, note, t.fg2, 11);
  });

  // a year of contributions: one column per week, Sunday at the top
  const weeks = calendar.weeks.slice(-53);
  const gap = 3;
  // as large as fits the card's width
  const cell = Math.floor((W - pad * 2 + gap) / weeks.length) - gap;
  const top = 150;
  const level = (n) => (n === 0 ? -1 : quart.filter((q) => n > q).length);
  const gx = pad;
  weeks.forEach((w, wi) => {
    const first = new Date(w.contributionDays[0].date);
    if (first.getUTCDate() <= 7) text(gx + wi * (cell + gap), top - 8, first.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toLowerCase(), t.fg3, 9.5);
    w.contributionDays.forEach((d) => {
      const dow = new Date(d.date).getUTCDay();
      const l = level(d.contributionCount);
      out.push(
        `<rect x="${gx + wi * (cell + gap)}" y="${top + dow * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" fill="${l < 0 ? t.empty : t.ramp[l]}"><title>${d.date}: ${d.contributionCount}</title></rect>`,
      );
    });
  });
  const gridBottom = top + 7 * (cell + gap) - gap;
  // legend
  // the legend ends where the card's content does, with room for "more"
  const lx = W - pad - 30 - (5 * (cell + gap) - gap);
  text(lx - 34, gridBottom + 22, "less", t.fg3, 9.5);
  [t.empty, ...t.ramp].forEach((c, i) => out.push(`<rect x="${lx + i * (cell + gap)}" y="${gridBottom + 13}" width="${cell}" height="${cell}" rx="2.5" fill="${c}"/>`));
  text(lx + 5 * (cell + gap) + 3, gridBottom + 22, "more", t.fg3, 9.5);

  // languages: name, a thin bar, a share. One colour: the bar shows how much, not which.
  let y = gridBottom + 52;
  text(pad, y, "LANGUAGES", t.fg3, 10, ' letter-spacing="1.4"');
  y += 8;
  const barX = pad + 120;
  const barW = W - pad * 2 - 120 - 56;
  for (const l of languages) {
    y += 20;
    text(pad, y, l.name, t.fg, 11.5);
    out.push(`<rect x="${barX}" y="${y - 6}" width="${barW}" height="4" rx="2" fill="${t.empty}"/>`);
    out.push(`<rect x="${barX}" y="${y - 6}" width="${Math.max(4, barW * l.share).toFixed(1)}" height="4" rx="2" fill="${t.accent}"/>`);
    text(W - pad, y, `${(l.share * 100).toFixed(1)}%`, t.fg2, 11, ' text-anchor="end"');
  }
  if (languages.length === 0) text(pad, (y += 20), "no public code yet", t.fg2, 11.5);

  const H = y + 26;
  const updated = new Date().toISOString().slice(0, 10);
  text(W - pad, 38, `updated ${updated}`, t.fg3, 10.5, ' text-anchor="end"');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${LOGIN} on GitHub: ${calendar.totalContributions} contributions in the last year`)}">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.bg}" stroke="${t.line}"/>
${out.join("\n")}
</svg>
`;
}

for (const [mode, t] of Object.entries(THEMES)) writeFileSync(new URL(`../assets/stats-${mode}.svg`, import.meta.url), card(t));

// ---- the README lists ---------------------------------------------------------------------------------------------

const day = (d) => new Date(d).toISOString().slice(0, 10);
const readmeUrl = new URL("../README.md", import.meta.url);
let readme = readFileSync(readmeUrl, "utf8");
const fill = (name, body) => {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(readme)) throw new Error(`README.md has no ${name} markers`);
  readme = readme.replace(re, `$1\n${body}\n$2`);
};

const list = await posts();
if (list) fill("POSTS", list.length ? list.map((p) => `- \`${day(p.date)}\` [${p.title}](${p.link})`).join("\n") : "- Nothing published yet. [otis.zone/blog](https://otis.zone/blog) is where it will be.");
const done = await activity();
fill("ACTIVITY", done.length ? done.map((a) => `- \`${day(a.date)}\` ${a.text}`).join("\n") : "- Quiet lately, in public at least.");
writeFileSync(readmeUrl, readme);

console.log(`card: ${calendar.totalContributions} contributions, streak ${current}/${longest}, ${languages.length} languages; posts: ${list ? list.length : "feed unreadable"}; activity: ${done.length}`);
