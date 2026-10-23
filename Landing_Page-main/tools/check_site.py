#!/usr/bin/env python3
"""Static checks for the public site. Run from the repo root:  python3 tools/check_site.py
- every internal href/src resolves to a file (and #anchor to an id on that page)
- no model answers from the demo pool appear in public HTML/JS
- no unverified claims that were removed in the redesign creep back onto marketing pages
Exit code 1 on any failure."""
import pathlib, re, sys, html
ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = sorted(p for p in ROOT.glob("*.html"))
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

# Sign-in and sign-up live on onboard.threatready.io; the site has no /app (the old links looped through 404.html)
for p in PAGES:
    if "threatready.io/app" in re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S):
        fail.append(f"{p.name}: links to threatready.io/app (use https://onboard.threatready.io/)")

# Every external http(s) link (not threatready.io or one of its apps) opens in a new tab with noopener noreferrer
for p in PAGES:
    s = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)
    for a in re.findall(r'<a\b[^>]*href="https?://[^"]+"[^>]*>', s):
        href = re.search(r'href="([^"]+)"', a).group(1)
        if re.match(r"https?://([a-z0-9-]+\.)?threatready\.io(/|$)", href): continue
        if 'target="_blank"' not in a or "noopener" not in a or "noreferrer" not in a:
            fail.append(f"{p.name}: external link not new-tab: {href}")

# No stretched-link overlays (root cause of the click-anywhere bug)
css = (ROOT / "assets/css/site.css").read_text(encoding="utf-8")
if re.search(r"\.link::after\{[^}]*position:absolute[^}]*inset:0", css):
    fail.append("site.css: stretched-link overlay rule present")

print("\n".join(fail) if fail else f"OK — {len(PAGES)} pages, links/anchors/claims clean")
sys.exit(1 if fail else 0)
