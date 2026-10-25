#!/usr/bin/env python3
"""Regression tests for the site generator and checker (BIZ-01/UI-2 app host, BIZ-07 plan copy,
UI-15 scroll regions). Run from the repo root:  python3 -m unittest Landing_Page-main/tools/test_site_tools.py
Each checker test runs on a scratch copy of the site; the real pages are never modified."""
import os, pathlib, shutil, subprocess, sys, tempfile, unittest

TOOLS = pathlib.Path(__file__).resolve().parent
SITE = TOOLS.parent
sys.path.insert(0, str(TOOLS))
import sync_shell  # noqa: E402


class GeneratorTest(unittest.TestCase):
    def test_one_platform_url_feeds_every_app_link(self):
        self.assertEqual(sync_shell.APP_LINKS["signin"], sync_shell.PLATFORM_URL + "/")
        self.assertEqual(sync_shell.APP_LINKS["signup"], sync_shell.PLATFORM_URL + "/?mode=signup")
        self.assertEqual(sync_shell.APP_LINKS["labs"], sync_shell.PLATFORM_URL + "/labs/")
        self.assertIn('data-app="signin"', sync_shell.nav(""))

    def test_legacy_app_links_are_adopted_and_rewritten(self):
        page = ('<a class="signin" href="https://onboard.threatready.io/">Sign in</a>'
                '<a class="btn" href="https://onboard.threatready.io/?mode=signup">Start free</a>'
                '<a href="https://labs.threatready.io/labs/">Browse</a>'
                '<a href="https://threatready.io/app/auth?mode=signup&amp;plan=free">Old</a>'
                '<a href="https://aerovanttech.com/">Company</a><a href="pricing.html">Pricing</a>')
        out = sync_shell.app_links(page)
        L = sync_shell.APP_LINKS
        self.assertIn(f'href="{L["signin"]}" data-app="signin"', out)
        self.assertEqual(out.count(f'href="{L["signup"]}" data-app="signup"'), 2)
        self.assertIn(f'href="{L["labs"]}" data-app="labs"', out)
        self.assertNotIn("threatready.io/", out.replace("threatready.onrender.com", ""))
        self.assertIn('href="https://aerovanttech.com/">', out)
        self.assertEqual(sync_shell.app_links(out), out, "idempotent")

    def test_scroll_regions_become_focusable(self):
        out = sync_shell.scroll_regions('<div class="cmp-wrap" aria-label="Modules"><table></table></div>')
        self.assertIn('tabindex="0"', out)
        self.assertIn('role="region"', out)
        self.assertEqual(sync_shell.scroll_regions(out), out)


def run_check(site, *args, env=None):
    return subprocess.run([sys.executable, str(site / "tools" / "check_site.py"), *args], capture_output=True, text=True,
                          env={**os.environ, **(env or {})})


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="tr-site-"))
        self.site = self.tmp / "site"
        shutil.copytree(SITE, self.site, ignore=shutil.ignore_patterns("__pycache__"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, name, old, new):
        p = self.site / name
        s = p.read_text(encoding="utf-8")
        self.assertIn(old, s)
        p.write_text(s.replace(old, new, 1), encoding="utf-8")

    def test_generated_site_passes(self):
        r = run_check(self.site, "--offline")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_dead_app_host_fails(self):
        self.edit("index.html", 'href="https://aerovanttech.com/"', 'href="https://onboard.threatready.io/app/profile"')
        r = run_check(self.site, "--offline")
        self.assertEqual(r.returncode, 1)
        self.assertIn("unknown app host onboard.threatready.io", r.stdout)

    def test_stale_data_app_link_fails(self):
        self.edit("pricing.html", f'href="{sync_shell.APP_LINKS["signup"]}" data-app="signup"', 'href="https://labs.threatready.io/" data-app="signup"')
        r = run_check(self.site, "--offline")
        self.assertIn("should be " + sync_shell.APP_LINKS["signup"], r.stdout)

    def test_non_resolving_platform_host_fails(self):
        r = run_check(self.site, env={"TR_PLATFORM_URL": "https://onboard.invalid"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("does not resolve", r.stdout)

    def test_trial_and_in_app_price_claims_fail(self):
        self.edit("pricing.html", "<li>No credit card required</li>", "<li>Two Beginner scenarios, then see the price in the app</li>")
        self.edit("terms.html", "<h3>4.1 Free use</h3>", "<h3>4.1 Free trial</h3>")
        r = run_check(self.site, "--offline")
        self.assertIn("pricing.html: plan claim", r.stdout)
        self.assertIn("terms.html: plan claim", r.stdout)

    def test_unwrapped_table_and_unnamed_region_fail(self):
        self.edit("rubric.html", '<div class="tscroll" aria-label="Rubric version history" tabindex="0" role="region">\n<table>', "<table>")
        self.edit("interviewprep.html", '<div class="cmp-wrap" aria-label="Interview modules"', '<div class="cmp-wrap"')
        r = run_check(self.site, "--offline")
        self.assertIn("rubric.html: <table> not inside a scroll region", r.stdout)
        self.assertIn("interviewprep.html: scroll region needs", r.stdout)


if __name__ == "__main__":
    unittest.main()
