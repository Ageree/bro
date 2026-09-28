"""Profile persistence probe: read the marker a previous boot left, then write this boot's marker."""

import json
import sys

from jev_ultrafast.browser import Browser

marker = sys.argv[1]
browser = Browser("https://example.com/")
try:
    before = {
        "local_storage": browser.evaluate("localStorage.getItem('bro_pilot')"),
        "cookie": browser.evaluate("document.cookie"),
    }
    browser.evaluate(f"localStorage.setItem('bro_pilot', {json.dumps(marker)})")
    browser.evaluate(f"document.cookie = 'bro_pilot=' + {json.dumps(marker)} + '; max-age=31536000; path=/'")
    after = browser.evaluate("localStorage.getItem('bro_pilot')")
finally:
    browser.close()
print(json.dumps({"previous": before, "written": marker, "readback": after}))
