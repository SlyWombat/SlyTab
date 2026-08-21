#!/usr/bin/env python3
"""Google Play Developer API from this machine, with no google-auth.

    PATH=/usr/bin:/bin python3 scripts/ops/play-api.py tracks
    PATH=/usr/bin:/bin python3 scripts/ops/play-api.py upload-aab <file> "SlyTab 1.2.0 (20)" "release notes"
    PATH=/usr/bin:/bin python3 scripts/ops/play-api.py screenshots <dir-of-pngs> [--language en-US]
    PATH=/usr/bin:/bin python3 scripts/ops/play-api.py promote <versionCode> --track production [--status draft]

Why a hand-rolled JWT: `google-auth` is not installed here and this box is not
where dependencies get added lightly, while `cryptography` is. The signing is
twenty lines and the alternative was a scratch script rewritten from memory
every time a release came round — which is exactly how a step gets forgotten.

Everything happens inside an **edit**: create one, change things, commit. An
uncommitted edit is invisible and expires by itself, so a failure part way
through leaves the listing exactly as it was. The edit is deleted on the way
out of an error for the same reason.

Two rules this file exists to keep:

  - **Production is never touched by default.** `upload-aab` puts the bundle
    on the internal track and stops. Promoting is a human decision (see
    docs/play-listing.md) and needs `promote` to be typed on purpose.
  - **Screenshots are ordered by filename**, because that is the order Play
    shows them in and 01-home should be first.

The service-account key lives in `secrets/play-service-account.json` and is
never printed.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

PKG = 'ca.electricrv.slytab'
REPO = Path(__file__).resolve().parents[2]
KEY = REPO / 'secrets' / 'play-service-account.json'
BASE = f'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{PKG}'
UPLOAD = f'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{PKG}'
TRACKS = ('internal', 'alpha', 'beta', 'production')
# The listing SlyTab actually has. Not cosmetic: the images endpoints 404 —
# with an HTML error page, not a JSON one — for a language with no listing,
# which is a confusing way to find out you guessed en-US.
DEFAULT_LANG = 'en-CA'


def _b64(raw: bytes) -> bytes:
    return base64.urlsafe_b64encode(raw).rstrip(b'=')


def token() -> str:
    """A service-account access token, signed here rather than by a library."""
    sa = json.loads(KEY.read_text())
    now = int(time.time())
    header = _b64(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    claim = _b64(json.dumps({
        'iss': sa['client_email'],
        'scope': 'https://www.googleapis.com/auth/androidpublisher',
        'aud': 'https://oauth2.googleapis.com/token',
        'iat': now, 'exp': now + 3600,
    }).encode())
    key = serialization.load_pem_private_key(sa['private_key'].encode(), password=None)
    sig = _b64(key.sign(header + b'.' + claim, padding.PKCS1v15(), hashes.SHA256()))
    r = requests.post('https://oauth2.googleapis.com/token', timeout=30, data={
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion': (header + b'.' + claim + b'.' + sig).decode(),
    })
    r.raise_for_status()
    return r.json()['access_token']


def call(method: str, path: str, tok: str, **kw) -> dict:
    r = requests.request(method, BASE + path, timeout=300,
                         headers={'Authorization': f'Bearer {tok}'}, **kw)
    if r.status_code >= 300:
        raise SystemExit(f'{method} {path} -> {r.status_code}: {r.text[:600]}')
    return r.json() if r.text.strip() else {}


class Edit:
    """An edit that commits on a clean exit and is thrown away on an error."""

    def __init__(self, tok: str) -> None:
        self.tok = tok

    def __enter__(self) -> 'Edit':
        self.id = call('POST', '/edits', self.tok)['id']
        return self

    def __exit__(self, exc_type, *_rest) -> bool:
        if exc_type is None:
            call('POST', f'/edits/{self.id}:commit', self.tok)
            print('committed')
        else:
            try:
                call('DELETE', f'/edits/{self.id}', self.tok)
                print('edit discarded — nothing changed', file=sys.stderr)
            except SystemExit:
                pass
        return False


def cmd_tracks(_args: argparse.Namespace) -> None:
    tok = token()
    edit = call('POST', '/edits', tok)['id']
    try:
        for track in TRACKS:
            try:
                t = call('GET', f'/edits/{edit}/tracks/{track}', tok)
            except SystemExit:
                continue
            for rel in t.get('releases', []):
                print(f"{track:11} status={rel.get('status'):10} "
                      f"codes={rel.get('versionCodes')} name={rel.get('name')}")
    finally:
        call('DELETE', f'/edits/{edit}', tok)


def cmd_upload_aab(args: argparse.Namespace) -> None:
    tok = token()
    with Edit(tok) as e:
        with open(args.file, 'rb') as f:
            r = requests.post(
                f'{UPLOAD}/edits/{e.id}/bundles?uploadType=media', data=f, timeout=1800,
                headers={'Authorization': f'Bearer {tok}',
                         'Content-Type': 'application/octet-stream'})
        if r.status_code >= 300:
            raise SystemExit(f'bundle upload -> {r.status_code}: {r.text[:600]}')
        code = r.json()['versionCode']
        print(f'uploaded versionCode {code}')
        call('PUT', f'/edits/{e.id}/tracks/internal', tok, json={'releases': [{
            'name': args.name,
            'versionCodes': [str(code)],
            'status': 'completed',
            'releaseNotes': [{'language': args.language, 'text': args.notes}],
        }]})
        print('internal track set — production untouched')


def cmd_promote(args: argparse.Namespace) -> None:
    tok = token()
    with Edit(tok) as e:
        body = {'releases': [{
            'name': args.name or f'SlyTab ({args.version_code})',
            'versionCodes': [str(args.version_code)],
            'status': args.status,
        }]}
        if args.notes:
            body['releases'][0]['releaseNotes'] = [{'language': args.language, 'text': args.notes}]
        call('PUT', f'/edits/{e.id}/tracks/{args.track}', tok, json=body)
        print(f'{args.track} release {args.version_code} status={args.status}')


def cmd_screenshots(args: argparse.Namespace) -> None:
    pngs = sorted(Path(args.dir).glob('*.png'))
    if not pngs:
        raise SystemExit(f'no PNGs in {args.dir}')
    tok = token()
    with Edit(tok) as e:
        # Replace rather than append: Play keeps up to eight and appending a
        # second set would leave the old screens on the listing, first.
        # Under listings/{language}/{imageType}, not images/{language}/... —
        # the latter is not a Play API path at all and answers with an HTML
        # 404 page, which reads like a missing listing rather than a typo.
        call('DELETE', f'/edits/{e.id}/listings/{args.language}/phoneScreenshots', tok)
        for png in pngs:
            with open(png, 'rb') as f:
                r = requests.post(
                    f'{UPLOAD}/edits/{e.id}/listings/{args.language}/phoneScreenshots?uploadType=media',
                    data=f, timeout=600,
                    headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'image/png'})
            if r.status_code >= 300:
                raise SystemExit(f'{png.name} -> {r.status_code}: {r.text[:400]}')
            print(f'  uploaded {png.name}')


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest='cmd', required=True)

    sub.add_parser('tracks', help='what each track is serving').set_defaults(fn=cmd_tracks)

    up = sub.add_parser('upload-aab', help='upload a bundle to the internal track')
    up.add_argument('file')
    up.add_argument('name', help='release name, e.g. "SlyTab 1.2.0 (20)"')
    up.add_argument('notes', help="what's new, <=500 chars")
    up.add_argument('--language', default=DEFAULT_LANG)
    up.set_defaults(fn=cmd_upload_aab)

    pr = sub.add_parser('promote', help='put an existing versionCode on a track')
    pr.add_argument('version_code', type=int)
    pr.add_argument('--track', default='production', choices=TRACKS)
    pr.add_argument('--status', default='draft', choices=('draft', 'completed', 'inProgress'))
    pr.add_argument('--name')
    pr.add_argument('--notes')
    pr.add_argument('--language', default=DEFAULT_LANG)
    pr.set_defaults(fn=cmd_promote)

    sc = sub.add_parser('screenshots', help='replace the phone screenshots on the listing')
    sc.add_argument('dir')
    sc.add_argument('--language', default=DEFAULT_LANG)
    sc.set_defaults(fn=cmd_screenshots)

    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
