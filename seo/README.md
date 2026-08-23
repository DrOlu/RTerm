# rterm.app — SEO Fix-Pack

> **✅ DEPLOYED LIVE 2026-08-23** — index.html upgraded on the Apache host
> (`~/public_html/`, user `rtermapp@131.153.147.50`). Original page backed up as
> `index.html.bak-20260823` on the server (restore = `cp index.html.bak-20260823 index.html`).
> Verified live: title/desc/keywords/canonical/OG+Twitter cards/JSON-LD/og-image(200)/robots.txt/sitemap.xml/http→https 301/www→apex 301, new H1 + AIOps/AI-SRE section (FDE ×5, AI SRE ×7 in page text).
>
> **Note:** password auth works; pubkey auth is disabled server-side (sshd rejects even localhost self-test → cPanel/WHM `PubkeyAuthentication` off). Enable via WHM → Security Center → SSH Password Authorization Tweak, or ask host support. Rotate the shared password after enabling keys.

Everything needed to make rterm.app rank for **"forward deployed engineer tool"**,
**"AI SRE"**, **"agentic AI operations"**, and related searches.

## Audit result (2026-08-23)

| Check | Status |
|---|---|
| Title | ⚠️ generic ("The AI-Native Terminal") — no persona/category terms |
| Meta description | ⚠️ no FDE/AIOps/AI-SRE terms |
| Canonical | ❌ missing (http + www duplicates split authority) |
| og:image / twitter card | ❌ missing |
| JSON-LD structured data | ❌ missing |
| robots.txt | ❌ 404 |
| sitemap.xml | ❌ 404 |
| "Forward Deployed"/"FDE"/"AI SRE" in page text | ❌ zero occurrences |
| H1 | ⚠️ 1 (good) but keyword-free |

## Files

| File | What it is | Where it goes |
|---|---|---|
| `head-snippet.html` | New `<title>`, meta, canonical, OG/Twitter, JSON-LD | Replace the matching tags in the site's `<head>` |
| `body-snippet.html` | New H1 + "AIOps, AI SRE & Agentic Ops" section + internal links | Homepage body edits |
| `robots.txt` | Crawl rules incl. AI/LLM crawlers (GPTBot, ClaudeBot…) | Site root (`/var/www/…/robots.txt`) |
| `sitemap.xml` | 3 URLs | Site root |
| `og-image.png` | *(you provide)* 1200×630 PNG | Site root |

## Deploy checklist

1. Upload `robots.txt` + `sitemap.xml` to the Apache docroot.
2. Apply `head-snippet.html` tags to the homepage `<head>` (replace old title/desc/keywords/og).
3. Add an `og-image.png` (1200×630) to the site root.
4. Apply the body edits from `body-snippet.html`.
5. **Apache config (one-time):** force https + apex canonical host:
   ```apache
   RewriteEngine On
   RewriteCond %{HTTPS} !=on [OR]
   RewriteCond %{HTTP_HOST} !^rterm\.app$ [NC]
   RewriteRule ^(.*)$ https://rterm.app/$1 [R=301,L]
   ```
6. Verify:
   ```bash
   curl -s https://rterm.app/robots.txt          # 200
   curl -s https://rterm.app/sitemap.xml         # 200
   curl -sI http://www.rterm.app | head -3       # 301 → https://rterm.app
   ```
7. Submit sitemap at [Google Search Console](https://search.google.com/search-console)
   and Bing Webmaster Tools. Request indexing of `/`.

## Off-site levers (do after deploy)

- **Google Business Profile** not applicable; instead: list RTerm on
  **AlternativeTo**, **Product Hunt** (ship a launch), **awesome-fde-resources** PR,
  **HN Show HN**, r/devops, r/sre.
- Every external mention should use anchor text like
  *"RTerm — AI terminal for Forward Deployed Engineers"* (not "click here").
- Publish 2–3 comparison posts on GitHub or Medium:
  "RTerm vs AIOps platforms", "AI SRE tools compared", "What is an FDE tool?"
  — long-tail queries with low competition.
- Keep GitHub topics + npm keywords in sync (already done this session).
