"""Shared stdlib HTTP core for every urllib client in the SDK.

One opener, one policy, four clients (hosted, browser credentials, browser
profiles, managed secrets). REDIRECTS ARE DISABLED: urllib's default opener
replays a redirected request at whatever Location the server names — with the
original headers, Authorization included, across hosts — so a redirecting (or
compromised) endpoint could bounce the caller's bearer key to a host of its
choosing. Here a 3xx is surfaced as the HTTPError it is, never followed.

Zero-dependency on purpose: stdlib only, like everything it replaces.
"""

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


class _RedirectRefusedHandler(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: returning None makes the 3xx raise as HTTPError."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# build_opener drops the default HTTPRedirectHandler because a subclass of it
# is supplied — every other default handler (HTTPS, proxies) stays.
_OPENER = urllib.request.build_opener(_RedirectRefusedHandler())


def urlopen(request: urllib.request.Request, timeout: Optional[float] = None):
    """Open ``request`` without ever following a redirect.

    The single seam every SDK HTTP call goes through — tests patch
    ``evolve._http.urlopen``, and a call that bypasses it bypasses the
    redirect policy too.
    """
    return _OPENER.open(request, timeout=timeout)


def request_json(
    url: str,
    *,
    api_key: str,
    error_prefix: str,
    method: str = 'GET',
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 30,
) -> Dict[str, Any]:
    """One authenticated JSON request against the dashboard API (sync).

    The request/parse/error shape the three standalone dashboard clients used
    to carry as three private copies. An HTTP failure raises RuntimeError as
    ``"{error_prefix} request failed (status): detail"``; an empty body is an
    empty dict.
    """
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
    }
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'{error_prefix} request failed ({exc.code}): {detail}') from exc
    return json.loads(payload) if payload else {}
