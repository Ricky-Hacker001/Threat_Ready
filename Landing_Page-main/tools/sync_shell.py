#!/usr/bin/env python3
"""Keep the shared navigation and footer identical on every public page.

The site is plain static HTML (no build step). Each page carries marker comments:
    <!-- @nav -->   ... <!-- /@nav -->
    <!-- @footer --> ... <!-- /@footer -->
Edit the templates below, then run:   python3 tools/sync_shell.py
A page may set its active nav item with <body data-nav="pricing"> (product|teams|scoring|resources|pricing).

Links into the platform, anywhere on any page (404.html too), carry data-app="signin|signup|labs" and
get their href from PLATFORM_URL here, so the app host is written in one place. A pasted link to a
known app host (old threatready.io/app, onboard./labs. subdomains, the Render URL) is adopted the same
way. Scroll containers for wide tables (cmp-wrap, heat-wrap, tscroll) get tabindex="0" and
role="region" so keyboard users can scroll them; each needs its own aria-label.
"""
import os, pathlib, re, sys
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The live platform: one Render service, every app under one origin (deploy/README.md). Sign-in is at /,
# ?mode=signup opens Create account, the labs catalog is /labs/. When the platform moves to a custom
# domain, set it here (or TR_PLATFORM_URL for a one-off build) and re-run this script; the onboard
# PUBLIC_URL and OAuth redirect URIs must move with it.
PLATFORM_URL = os.environ.get("TR_PLATFORM_URL", "https://threatready.onrender.com").rstrip("/")
APP = PLATFORM_URL + "/"
SIGNUP = PLATFORM_URL + "/?mode=signup"
LABS = PLATFORM_URL + "/labs/"
APP_LINKS = {"signin": APP, "signup": SIGNUP, "labs": LABS}
# Hosts that have meant "the app" on this site; links to them are rewritten to PLATFORM_URL.
LEGACY_APP_HOSTS = {"onboard.threatready.io", "labs.threatready.io", "app.threatready.io", "threatready.onrender.com", urlparse(PLATFORM_URL).hostname}
SCROLL_WRAPS = ("cmp-wrap", "heat-wrap", "tscroll")
# The public site's own origin: canonical URLs, Open Graph URLs and the sitemap all use it.
SITE_URL = "https://threatready.io"

def canonical_url(name):
    """The canonical URL of a page file: index.html is the site root, every other page keeps its file name."""
    return SITE_URL + "/" + ("" if name == "index.html" else name)

def indexable(html):
    """A page is listed in the sitemap unless it asks not to be indexed (404.html)."""
    return not re.search(r'<meta\s+name="robots"\s+content="[^"]*noindex', html, re.I)

def sitemap(pages):
    """sitemap.xml: every indexable page at its canonical URL. No lastmod or priority: nothing here tracks them."""
    urls = [canonical_url(p.name) for p in pages if indexable(p.read_text(encoding="utf-8"))]
    urls.sort(key=lambda u: (u != SITE_URL + "/", u))  # the site root first, then by file name
    body = "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls)
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n"

CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"><path d="M6 9l6 6 6-6"/></svg>'

def nav(active):
    def cur(key):
        return ' aria-current="page"' if key == active else ''
    return f'''<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="top">
  <div class="wrap nav-in">
    <a class="brand" href="index.html" aria-label="ThreatReady home"><img src="logo-sm.png" width="26" height="25" alt="">ThreatReady</a>
    <nav aria-label="Primary">
      <ul class="nav-links">
        <li>
          <button class="nav-link" type="button" data-menu aria-expanded="false" aria-controls="menu-product"{cur("product")}>Product {CHEV}</button>
          <ul class="menu" id="menu-product">
            <li><a href="attack-reasoning-lab.html"><span class="dot dot-lab"></span><span><span class="mi-t">Attack Reasoning Lab</span><span class="mi-d">Reason through a live attack chain</span></span></a></li>
            <li><a href="lab-simulations.html"><span class="dot dot-sim"></span><span><span class="mi-t">Lab Simulations</span><span class="mi-d">Hands-on labs for the daily work of a role</span></span></a></li>
            <li><a href="interviewprep.html"><span class="dot dot-int"></span><span><span class="mi-t">InterviewPrep</span><span class="mi-d">An interview built from a real job description</span></span></a></li>
          </ul>
        </li>
        <li><a class="nav-link" href="pilot.html"{cur("teams")}>For Teams</a></li>
        <li><a class="nav-link" href="transparent-scoring.html"{cur("scoring")}>Scoring</a></li>
        <li>
          <button class="nav-link" type="button" data-menu aria-expanded="false" aria-controls="menu-resources"{cur("resources")}>Resources {CHEV}</button>
          <ul class="menu" id="menu-resources">
            <li><a href="resources.html"><span><span class="mi-t">All resources</span><span class="mi-d">Reports, rubric, workflow and trust documents</span></span></a></li>
            <li><a href="sample-report.html"><span><span class="mi-t">Sample report</span><span class="mi-d">A fictional candidate, the real format</span></span></a></li>
            <li><a href="rubric.html"><span><span class="mi-t">Scoring rubric</span><span class="mi-d">Five dimensions and score bands</span></span></a></li>
            <li><a href="how-it-works.html"><span><span class="mi-t">How it works</span><span class="mi-d">From role selection to report</span></span></a></li>
            <li><a href="security.html"><span><span class="mi-t">Security</span><span class="mi-d">How we protect your data</span></span></a></li>
            <li><a href="contact.html"><span><span class="mi-t">Contact</span><span class="mi-d">Sales, support, privacy and security</span></span></a></li>
          </ul>
        </li>
        <li><a class="nav-link" href="pricing.html"{cur("pricing")}>Pricing</a></li>
      </ul>
    </nav>
    <div class="nav-cta">
      <button class="theme-btn" type="button" data-theme-toggle aria-label="Switch to light theme">
        <svg class="icon i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
        <svg class="icon i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <a class="nav-link nav-signin" href="{APP}" data-app="signin">Sign in</a>
      <a class="btn btn-primary btn-sm" href="{SIGNUP}" data-app="signup">Start free</a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Open menu">
        <svg class="icon i-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        <svg class="icon i-close" viewBox="0 0 24 24" aria-hidden="true" style="display:none"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </div>
  <nav class="drawer" id="drawer" aria-label="Menu">
    <p class="drawer-h" id="drawer-product">Product</p>
    <ul aria-labelledby="drawer-product">
      <li><a href="attack-reasoning-lab.html">Attack Reasoning Lab</a></li>
      <li><a href="lab-simulations.html">Lab Simulations</a></li>
      <li><a href="interviewprep.html">InterviewPrep</a></li>
    </ul>
    <p class="drawer-h" id="drawer-company">Company</p>
    <ul aria-labelledby="drawer-company">
      <li><a href="pilot.html">For Teams</a></li>
      <li><a href="transparent-scoring.html">Scoring</a></li>
      <li><a href="pricing.html">Pricing</a></li>
      <li><a href="contact.html">Contact</a></li>
    </ul>
    <p class="drawer-h" id="drawer-resources">Resources</p>
    <ul aria-labelledby="drawer-resources">
      <li><a href="resources.html">All resources</a></li>
      <li><a href="sample-report.html">Sample report</a></li>
      <li><a href="rubric.html">Scoring rubric</a></li>
      <li><a href="how-it-works.html">How it works</a></li>
      <li><a href="security.html">Security</a></li>
    </ul>
    <div class="drawer-cta">
      <a class="btn btn-primary" href="{SIGNUP}" data-app="signup">Start free</a>
      <a class="btn btn-secondary" href="{APP}" data-app="signin">Sign in</a>
    </div>
  </nav>
</header>'''

SOCIAL = [
    ("LinkedIn", "https://www.linkedin.com/in/aerovant-technologies/", '<path d="M6 9v9M6 6v.01M10 18v-5a3 3 0 016 0v5M10 10v8"/><rect x="2" y="2" width="20" height="20" rx="4"/>'),
    ("X", "https://x.com/aerovant_tech", '<path d="M4 4l16 16M20 4L4 20"/>'),
    ("YouTube", "https://www.youtube.com/@aerovanttechnologies", '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>'),
    ("Instagram", "https://www.instagram.com/aerovant_technologies", '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5v.01"/>'),
    ("Facebook", "https://www.facebook.com/people/Aerovant-Technologies/61587139213075/", '<path d="M15 3h-2a4 4 0 00-4 4v3H7v4h2v7h4v-7h3l1-4h-4V7a1 1 0 011-1h2z"/>'),
]

NT = ' target="_blank" rel="noopener noreferrer"'

def footer():
    soc = "".join(
        f'<a href="{u}"{NT} aria-label="Aerovant Technologies on {n} (opens in a new tab)"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{p}</svg></a>'
        for n, u, p in SOCIAL)
    def grp(gid, title, items, newtab):
        sr = '<span class="sr-only"> (opens in a new tab)</span>'
        # The Contact page is part of this site, so it opens in the same tab even inside a new-tab group.
        tab = lambda h: newtab and h != "contact.html"
        lis = "".join(f'<li><a href="{h}"{NT if tab(h) else ""}>{t}{sr if tab(h) else ""}</a></li>' for h, t in items)
        return f'<nav aria-labelledby="{gid}"><h2 id="{gid}">{title}</h2><ul>{lis}</ul></nav>'
    product = grp("f-product", "Product", [("attack-reasoning-lab.html", "Attack Reasoning Lab"), ("lab-simulations.html", "Lab Simulations"),
        ("interviewprep.html", "InterviewPrep"), ("pricing.html", "Pricing"), ("pilot.html", "For teams")], False)
    resources = grp("f-resources", "Resources", [("resources.html", "All resources"), ("sample-report.html", "Sample report"),
        ("rubric.html", "Scoring rubric"), ("transparent-scoring.html", "How scoring works"), ("how-it-works.html", "How it works")], True)
    company = grp("f-company", "Company", [("https://aerovanttech.com/", "Aerovant Technologies"), ("https://aerovantacademy.com/", "Aerovant Academy"),
        ("contact.html", "Contact"), ("mailto:admin@aerovanttech.com", "admin@aerovanttech.com")], True)
    legal = grp("f-legal", "Legal", [("privacy.html", "Privacy policy"), ("terms.html", "Terms of service"),
        ("dpa.html", "Data processing agreement"), ("security.html", "Security")], True)
    return f'''<footer class="footer">
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-about">
        <a class="brand" href="index.html"><img src="logo-sm.png" width="26" height="25" alt="">ThreatReady</a>
        <p>Role-based assessment of security reasoning and interview readiness. A product of Aerovant Technologies.</p>
        <div class="social">{soc}</div>
      </div>
      {product}
      {resources}
      {company}
      {legal}
    </div>
    <div class="footer-bottom">
      <span>&copy; <span data-year>2026</span> Aerovant Technologies Pvt. Ltd.</span>
    </div>
  </div>
</footer>'''

def app_kind(href):
    """signin | signup | labs for a link into the platform (current or legacy host), else None."""
    u = urlparse(href)
    if u.scheme not in ("http", "https"): return None
    legacy_app = u.hostname in ("threatready.io", "www.threatready.io") and (u.path == "/app" or u.path.startswith("/app/"))
    if u.hostname not in LEGACY_APP_HOSTS and not legacy_app: return None
    if "mode=signup" in u.query: return "signup"
    if u.path.startswith("/labs") or u.hostname == "labs.threatready.io": return "labs"
    return "signin" if u.path in ("", "/", "/app", "/app/") or u.path.startswith("/app/auth") else None

def app_links(s):
    """Every <a data-app> gets its href from APP_LINKS; known app links without the marker are adopted."""
    def fix(m):
        tag = m.group(0)
        kind = re.search(r'\bdata-app="([a-z]+)"', tag)
        href = re.search(r'\bhref="([^"]*)"', tag)
        if not href: return tag
        if not kind:
            k = app_kind(href.group(1))
            if not k: return tag
            tag = tag.replace(href.group(0), f'{href.group(0)} data-app="{k}"', 1)
            kind_name = k
        else:
            kind_name = kind.group(1)
        if kind_name not in APP_LINKS: return tag
        return re.sub(r'\bhref="[^"]*"', f'href="{APP_LINKS[kind_name]}"', tag, count=1)
    return re.sub(r"<a\b[^>]*>", fix, s)

def scroll_regions(s):
    """A wide-table scroll container is focusable and a named region (keyboard scrolling, WCAG 2.1.1)."""
    def fix(m):
        tag = m.group(0)
        if 'tabindex=' not in tag: tag = tag[:-1] + ' tabindex="0">'
        if 'role=' not in tag: tag = tag[:-1] + ' role="region">'
        return tag
    return re.sub(r'<div class="(?:%s)"[^>]*>' % "|".join(SCROLL_WRAPS), fix, s)

def sync(path):
    s = path.read_text(encoding="utf-8")
    m = re.search(r'<body[^>]*data-nav="([a-z]+)"', s)
    active = m.group(1) if m else ""
    n0 = s
    s = re.sub(r"<!-- @nav -->.*?<!-- /@nav -->", lambda _: "<!-- @nav -->\n" + nav(active) + "\n<!-- /@nav -->", s, flags=re.S)
    s = re.sub(r"<!-- @footer -->.*?<!-- /@footer -->", lambda _: "<!-- @footer -->\n" + footer() + "\n<!-- /@footer -->", s, flags=re.S)
    s = app_links(s)
    s = scroll_regions(s)
    if s != n0:
        path.write_text(s, encoding="utf-8")
        return True
    return False

if __name__ == "__main__":
    pages = sorted(ROOT.glob("*.html"))
    changed = [p.name for p in pages if sync(p)]
    # The sitemap follows the pages: regenerated here, checked by tools/check_site.py.
    sm, xml = ROOT / "sitemap.xml", sitemap(pages)
    if not sm.exists() or sm.read_text(encoding="utf-8") != xml:
        sm.write_text(xml, encoding="utf-8", newline="\n")
        changed.append("sitemap.xml")
    print("synced:", ", ".join(changed) if changed else "nothing to change")
