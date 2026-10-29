#!/usr/bin/env python3
"""Static checks for the public site. Run from the repo root:  python3 tools/check_site.py [--offline]
- every internal href/src resolves to a file (and #anchor to an id on that page)
- no model answers from the demo pool appear in public HTML/JS
- no unverified claims that were removed in the redesign creep back onto marketing pages
- every link into the platform uses PLATFORM_URL (tools/sync_shell.py); a link to any other app host
  (*.threatready.io subdomains, *.onrender.com) fails, and the platform host must resolve in DNS
  (--offline skips only the DNS lookup)
- plan and pricing copy promises nothing the platform does not offer (no trial, no in-app prices)
- every wide-table scroll container is a focusable, named region
- SEO: one canonical per indexable page (its own URL), unique titles and descriptions of sensible length,
  complete Open Graph and Twitter tags, every <img> with alt and width/height, no duplicate ids, no Google
  Fonts (self-hosted in assets/fonts), robots.txt naming the sitemap, sitemap.xml in sync with the pages
Exit code 1 on any failure."""
import pathlib, re, sys, html, socket
from urllib.parse import urlparse
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sync_shell import APP_LINKS, PLATFORM_URL, SCROLL_WRAPS, SITE_URL, canonical_url, indexable, sitemap  # noqa: E402
PLATFORM_HOST = urlparse(PLATFORM_URL).hostname
PAGES = sorted(p for p in ROOT.glob("*.html"))
OFFLINE = "--offline" in sys.argv[1:]
fail = []

ids = {}
for p in PAGES:
    s = p.read_text(encoding="utf-8")
    ids[p.name] = set(re.findall(r'\bid="([^"]+)"', s))

for p in PAGES:
    s = p.read_text(encoding="utf-8")
    s_nocomment = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    for attr, url in re.findall(r'\b(href|src)="([^"]+)"', s_nocomment):
        url = html.unescape(url)
        if re.match(r"^(https?:|mailto:|tel:|data:|javascript:)", url):
            if url.startswith("javascript:"): fail.append(f"{p.name}: javascript: URL {url}")
            continue
        if url.startswith("/app/") or url == "/" or url.startswith("/"):
            continue  # absolute paths served by GitHub Pages (404/app handling)
        path, _, frag = url.partition("#")
        path = path.split("?")[0]
        target = p.name if path == "" else path
        if not (ROOT / target).exists():
            fail.append(f"{p.name}: missing file {url}")
            continue
        if frag and target.endswith(".html") and frag not in ids.get(target, set()):
            fail.append(f"{p.name}: missing anchor {url}")
    if p.name != "404.html" and 'href="#"' in s_nocomment:
        fail.append(f"{p.name}: dead href=\"#\"")

# Demo model answers must never ship to the browser
public = list(ROOT.glob("*.html")) + list((ROOT / "assets").rglob("*.js"))
for needle in ["modelAnswer", "Disable the Lambda function immediately", "Evict the pod and scale", "could be a typosquat or"]:
    for f in public:
        if needle in f.read_text(encoding="utf-8"):
            fail.append(f"{f.relative_to(ROOT)}: contains demo answer marker '{needle}'")

# Claims removed in the redesign must not reappear on marketing pages
MARKETING = ["index.html", "attack-reasoning-lab.html", "lab-simulations.html", "interviewprep.html", "pricing.html", "pilot.html",
             "how-it-works.html", "transparent-scoring.html", "resources.html", "contact.html"]
BANNED = [r"₹\s?\d", r"\$\d", r"Verified user", r"Career Genome", r"Hack The Box", r"TryHackMe", r"hosted in India",
          r"SOC 2 (certified|compliant)", r"Mydhili|Harish T|Surendhar|Prabu S|Lochana|Ezhil"]
for name in MARKETING:
    s = (ROOT / name).read_text(encoding="utf-8")
    for pat in BANNED:
        if re.search(pat, s, re.I):
            fail.append(f"{name}: unverified claim pattern /{pat}/")

# Footer: every link in Resources/Company/Legal groups and every social link opens in a new tab
for p in PAGES:
    if p.name == "404.html": continue
    s = p.read_text(encoding="utf-8")
    m = re.search(r'<footer class="footer">(.*?)</footer>', s, re.S)
    if not m: fail.append(f"{p.name}: missing shared footer"); continue
    f = m.group(1)
    for gid in ("f-resources", "f-company", "f-legal"):
        g = re.search(r'aria-labelledby="%s">(.*?)</nav>' % gid, f, re.S)
        for a in re.findall(r"<a [^>]*>", g.group(1) if g else ""):
            if 'href="contact.html"' in a:  # part of this site: same tab
                if 'target="_blank"' in a: fail.append(f"{p.name}: footer Contact opens a new tab")
                continue
            if 'target="_blank"' not in a or 'rel="noopener noreferrer"' not in a:
                fail.append(f"{p.name}: footer {gid} link not new-tab: {a}")
    soc = re.search(r'<div class="social">(.*?)</div>', f, re.S)
    for a in re.findall(r"<a [^>]*>", soc.group(1) if soc else ""):
        if 'target="_blank"' not in a: fail.append(f"{p.name}: social link not new-tab")
    if 'data-theme-toggle' not in s: fail.append(f"{p.name}: header theme toggle missing")

# Sign-in and sign-up live on the platform (PLATFORM_URL); the site has no /app (the old links looped through 404.html)
for p in PAGES:
    if "threatready.io/app" in re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S):
        fail.append(f"{p.name}: links to threatready.io/app (use {APP_LINKS['signin']}; run tools/sync_shell.py)")

# App links: one host, written by sync_shell.py. Anything that looks like an app host but is not the
# platform (onboard.threatready.io, labs.threatready.io, another *.onrender.com service) is a dead or
# wrong link. Sign-in / Start free / ?mode=signup links must carry data-app so sync keeps them current.
SITE_HOSTS = {"threatready.io", "www.threatready.io"}
APP_HOST = re.compile(r"^([a-z0-9-]+\.)+(threatready\.io|onrender\.com)$")
for p in PAGES:
    s = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)
    for m in re.finditer(r"<a\b([^>]*)>(.*?)</a>", s, re.S):
        tag, text = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        href_m = re.search(r'\bhref="([^"]*)"', tag)
        if not href_m: continue
        href = html.unescape(href_m.group(1))
        kind = re.search(r'\bdata-app="([^"]*)"', tag)
        if kind:
            want = APP_LINKS.get(kind.group(1))
            if not want: fail.append(f"{p.name}: unknown data-app=\"{kind.group(1)}\" (signin, signup or labs)")
            elif href != want: fail.append(f"{p.name}: app link {href} should be {want} (run tools/sync_shell.py)")
            continue
        host = urlparse(href).hostname or ""
        if host and host not in SITE_HOSTS and (APP_HOST.match(host) or host == PLATFORM_HOST) and not href.startswith(PLATFORM_URL + "/"):
            fail.append(f"{p.name}: link to unknown app host {host} ({href}); the platform is {PLATFORM_URL}")
        if "mode=signup" in href or text in ("Sign in", "Start free") or text.startswith("Start free"):
            fail.append(f"{p.name}: sign-in/sign-up link without data-app: {href} (run tools/sync_shell.py)")
if not OFFLINE:
    try:
        socket.getaddrinfo(PLATFORM_HOST, 443)
    except OSError as e:
        fail.append(f"PLATFORM_URL host {PLATFORM_HOST} does not resolve ({e}); every sign-in link would be dead (--offline skips this lookup)")

# Every external http(s) link (not threatready.io or the platform) opens in a new tab with noopener noreferrer
for p in PAGES:
    s = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)
    for a in re.findall(r'<a\b[^>]*href="https?://[^"]+"[^>]*>', s):
        href = re.search(r'href="([^"]+)"', a).group(1)
        if re.match(r"https?://([a-z0-9-]+\.)?threatready\.io(/|$)", href) or href.startswith(PLATFORM_URL + "/"): continue
        if 'target="_blank"' not in a or "noopener" not in a or "noreferrer" not in a:
            fail.append(f"{p.name}: external link not new-tab: {href}")

# Plan copy describes the platform as it is: free accounts with per-product limits, nothing on sale,
# no guest trial (onboard TRIAL_ENABLED is off by default). Promises of the old app must not return.
PLAN_PAGES = MARKETING + ["terms.html", "sample-report.html"]
PLAN_BANNED = [r"two \(?2?\)?\s*(free\s+)?Beginner", r"two free Beginner", r"price in the app", r"shown in the app before you pay", r"free trial",
               r"after your trial"]
for name in PLAN_PAGES:
    s = (ROOT / name).read_text(encoding="utf-8")
    for pat in PLAN_BANNED:
        if re.search(pat, s, re.I):
            fail.append(f"{name}: plan claim the platform does not offer /{pat}/")

# Wide tables: the scroll container is focusable and a named region (keyboard users can scroll it)
for p in PAGES:
    s = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)
    for m in re.finditer(r"<table\b", s):
        opener = re.findall(r"<div\b[^>]*>", s[:m.start()])
        last = opener[-1] if opener else ""
        between = s[s.rfind(last, 0, m.start()) + len(last):m.start()] if last else ""
        if not re.search(r'class="(%s)"' % "|".join(SCROLL_WRAPS), last) or re.search(r"<(table|/div)\b", between):
            fail.append(f"{p.name}: <table> not inside a scroll region (wrap it in <div class=\"tscroll\" aria-label=\"...\">)")
    for d in re.findall(r'<div class="(?:%s)"[^>]*>' % "|".join(SCROLL_WRAPS), s):
        if 'tabindex="0"' not in d or 'role="region"' not in d or not re.search(r'aria-label="[^"]+"', d):
            fail.append(f"{p.name}: scroll region needs tabindex=\"0\", role=\"region\" and an aria-label: {d}")

# No stretched-link overlays (root cause of the click-anywhere bug)
css = (ROOT / "assets/css/site.css").read_text(encoding="utf-8")
if re.search(r"\.link::after\{[^}]*position:absolute[^}]*inset:0", css):
    fail.append("site.css: stretched-link overlay rule present")

# SEO and markup hygiene. Titles stay under what results pages show in full and descriptions under the
# truncation point; an indexable page carries exactly one canonical (its own URL, which og:url repeats),
# the Open Graph set and a Twitter card. Duplicate ids silently rename labels and landmarks
# (aria-labelledby picks the first), and an <img> without width/height shifts the layout while it loads.
TITLE_MAX, DESC_MIN, DESC_MAX = 80, 50, 180
seen_titles, seen_descs = {}, {}
for p in PAGES:
    s = p.read_text(encoding="utf-8")
    m = re.search(r"<title>(.*?)</title>", s, re.S)
    title = html.unescape(m.group(1).strip()) if m else ""
    if not title: fail.append(f"{p.name}: missing <title>")
    elif len(title) > TITLE_MAX: fail.append(f"{p.name}: title is {len(title)} characters (max {TITLE_MAX})")
    if title and title in seen_titles: fail.append(f"{p.name}: title duplicates {seen_titles[title]}")
    seen_titles.setdefault(title, p.name)
    if re.search(r"fonts\.(googleapis|gstatic)\.com", s):
        fail.append(f"{p.name}: loads Google Fonts (fonts are self-hosted in assets/fonts)")
    all_ids = re.findall(r'\bid="([^"]+)"', s)
    for dup in sorted({i for i in all_ids if all_ids.count(i) > 1}):
        fail.append(f'{p.name}: duplicate id="{dup}"')
    for img in re.findall(r"<img\b[^>]*>", s):
        if not re.search(r'\balt="', img): fail.append(f"{p.name}: <img> without alt: {img[:80]}")
        if not (re.search(r'\bwidth="', img) and re.search(r'\bheight="', img)):
            fail.append(f"{p.name}: <img> without width/height: {img[:80]}")
    if not indexable(s): continue
    m = re.search(r'<meta\s+name="description"\s+content="([^"]*)"', s)
    desc = html.unescape(m.group(1)) if m else ""
    if not desc: fail.append(f"{p.name}: missing meta description")
    elif not DESC_MIN <= len(desc) <= DESC_MAX: fail.append(f"{p.name}: description is {len(desc)} characters ({DESC_MIN}-{DESC_MAX})")
    if desc and desc in seen_descs: fail.append(f"{p.name}: description duplicates {seen_descs[desc]}")
    seen_descs.setdefault(desc, p.name)
    canon = re.findall(r'<link\s+rel="canonical"\s+href="([^"]*)"', s)
    if canon != [canonical_url(p.name)]:
        fail.append(f"{p.name}: canonical should be exactly {canonical_url(p.name)} (found {', '.join(canon) or 'none'})")
    for prop in ("og:title", "og:description", "og:image", "og:url"):
        if not re.search(r'<meta\s+property="%s"\s+content="[^"]+"' % re.escape(prop), s): fail.append(f"{p.name}: missing {prop}")
    m = re.search(r'<meta\s+property="og:url"\s+content="([^"]*)"', s)
    if m and m.group(1) != canonical_url(p.name): fail.append(f"{p.name}: og:url {m.group(1)} differs from the canonical URL")
    if not re.search(r'<meta\s+name="twitter:card"\s+content="(summary|summary_large_image)"', s): fail.append(f"{p.name}: missing twitter:card")
for f in sorted((ROOT / "assets/css").glob("*.css")):
    if re.search(r"fonts\.(googleapis|gstatic)\.com", f.read_text(encoding="utf-8")):
        fail.append(f"{f.relative_to(ROOT).as_posix()}: imports Google Fonts (fonts are self-hosted in assets/fonts)")

# Crawl files: robots.txt names the sitemap, and sitemap.xml is exactly what tools/sync_shell.py generates
# from the indexable pages (so a new or noindexed page never leaves it stale).
robots = ROOT / "robots.txt"
if not robots.exists(): fail.append("robots.txt: missing")
elif f"Sitemap: {SITE_URL}/sitemap.xml" not in robots.read_text(encoding="utf-8"):
    fail.append(f"robots.txt: must name the sitemap: Sitemap: {SITE_URL}/sitemap.xml")
sm = ROOT / "sitemap.xml"
if not sm.exists(): fail.append("sitemap.xml: missing (run tools/sync_shell.py)")
elif sm.read_text(encoding="utf-8") != sitemap(PAGES): fail.append("sitemap.xml: out of date with the indexable pages (run tools/sync_shell.py)")

print("\n".join(fail) if fail else f"OK — {len(PAGES)} pages, links/anchors/claims/SEO clean")
sys.exit(1 if fail else 0)
