"""Upload App Store screenshots to App Store Connect.

    python3 scripts/ops/upload-screenshots.py <dir-of-pngs> [--display APP_IPHONE_69] [--replace]

The capture workflow (.github/workflows/ios-screenshots.yml) leaves its PNGs as
a GitHub artifact rather than uploading them itself, deliberately: that would
mean putting the App Store Connect signing key into GitHub secrets. The key
stays on the owner's machine, where every other Apple operation in this repo
already runs from, and this script does the upload from there.

Apple's upload is a reservation protocol, not a POST of bytes:

  1. create (or reuse) an appScreenshotSet for the display type
  2. reserve an appScreenshot, declaring file name and size — Apple replies
     with one or more upload operations
  3. PUT the bytes to each operation's URL with its headers
  4. PATCH the screenshot with uploaded=true and the md5, which is Apple's
     check that what arrived is what was promised

Order matters on the store listing and is taken from the filenames, so
01-home.png comes first.

The display type for a 6.9-inch iPhone is APP_IPHONE_67, not APP_IPHONE_69 —
there is no APP_IPHONE_69 in the API's enum at all. Apple kept one slot for the
largest iPhone and it takes both 1290x2796 and 1320x2868; the marketing name
moved on and the constant did not. Guessing the obvious name gets a 409 whose
message lists thirty valid values and is truncated by most tools before it
reaches the one you need.
"""
import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import urllib.request

# scripts/ops/<this file> — three levels up is the repository root.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASC = os.path.join(REPO, "scripts/ops/asc-api.sh")
APP = "6794502588"


def call(method, path, payload=None):
    args = ["bash", ASC, method, path]
    tmp = None
    if payload is not None:
        tmp = os.path.join(REPO, ".asc-upload-body.json")
        with open(tmp, "w") as f:
            json.dump(payload, f)
        args.append(tmp)
    try:
        out = subprocess.run(args, capture_output=True, text=True, cwd=REPO).stdout
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    if not out.strip():
        # An empty reply means the helper did not run at all — a bad path, a
        # missing key. Reporting it as "no data" sent me looking at App Store
        # Connect for a version that was there the whole time.
        return {"errors": [{"title": "no output from asc-api.sh",
                            "detail": f"{method} {path} produced nothing — check the script path and .p8 key"}]}
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out[:400]}


def die(msg, res=None):
    print(f"  ✗ {msg}")
    if res and res.get("errors"):
        for e in res["errors"][:3]:
            print(f"      {e.get('title')} — {str(e.get('detail'))[:180]}")
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--display", default="APP_IPHONE_67",
                    help="Apple display type; the largest iPhone slot by default")
    ap.add_argument("--replace", action="store_true",
                    help="delete screenshots already in the set first")
    ap.add_argument("--dry-run", action="store_true",
                    help="resolve the version, locale and set without uploading anything")
    args = ap.parse_args()

    if not os.path.isdir(args.directory):
        die(f"no such directory: {args.directory}")
    pngs = sorted(
        os.path.join(args.directory, f)
        for f in os.listdir(args.directory)
        if f.lower().endswith(".png")
    )
    if not pngs and not args.dry_run:
        die(f"no PNGs in {args.directory}")
    print(f"  {len(pngs)} screenshot(s): {', '.join(os.path.basename(p) for p in pngs)}")

    # --- the localisation they attach to -----------------------------------
    versions = call("GET", f"/v1/apps/{APP}/appStoreVersions?limit=1")
    vdata = versions.get("data", [])
    if not vdata:
        die("no app store version to attach screenshots to", versions)
    version_id = vdata[0]["id"]
    print(f"  version {vdata[0]['attributes'].get('versionString')} ({vdata[0]['attributes'].get('appStoreState')})")

    locs = call("GET", f"/v1/appStoreVersions/{version_id}/appStoreVersionLocalizations")
    ldata = locs.get("data", [])
    if not ldata:
        die("no localisation on that version", locs)
    loc_id = ldata[0]["id"]
    print(f"  locale {ldata[0]['attributes'].get('locale')}")

    # --- the set for this display type -------------------------------------
    sets = call("GET", f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
    set_id = next((s["id"] for s in sets.get("data", [])
                   if s["attributes"].get("screenshotDisplayType") == args.display), None)
    if args.dry_run:
        print(f"  {args.display} set: {'exists' if set_id else 'would be created'}")
        print("  dry run — nothing uploaded")
        return
    if set_id is None:
        created = call("POST", "/v1/appScreenshotSets", {
            "data": {"type": "appScreenshotSets",
                     "attributes": {"screenshotDisplayType": args.display},
                     "relationships": {"appStoreVersionLocalization": {
                         "data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}})
        if created.get("errors"):
            die("could not create the screenshot set", created)
        set_id = created["data"]["id"]
        print(f"  created {args.display} set")
    else:
        print(f"  reusing {args.display} set")

    existing = call("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots").get("data", [])
    if existing and args.replace:
        for s in existing:
            call("DELETE", f"/v1/appScreenshots/{s['id']}")
        print(f"  removed {len(existing)} existing screenshot(s)")
    elif existing:
        die(f"{len(existing)} screenshot(s) already in this set — pass --replace to overwrite")

    # --- reserve, upload, commit -------------------------------------------
    for path in pngs:
        name = os.path.basename(path)
        blob = open(path, "rb").read()

        res = call("POST", "/v1/appScreenshots", {
            "data": {"type": "appScreenshots",
                     "attributes": {"fileName": name, "fileSize": len(blob)},
                     "relationships": {"appScreenshotSet": {
                         "data": {"type": "appScreenshotSets", "id": set_id}}}}})
        if res.get("errors"):
            die(f"reserve failed for {name}", res)

        shot = res["data"]
        for op in shot["attributes"].get("uploadOperations") or []:
            chunk = blob[op["offset"]:op["offset"] + op["length"]]
            req = urllib.request.Request(op["url"], data=chunk, method=op.get("method", "PUT"))
            for h in op.get("requestHeaders") or []:
                req.add_header(h["name"], h["value"])
            if not any((h["name"].lower() == "content-type") for h in (op.get("requestHeaders") or [])):
                req.add_header("Content-Type", mimetypes.guess_type(name)[0] or "image/png")
            with urllib.request.urlopen(req, timeout=180) as r:
                if r.status not in (200, 201, 204):
                    die(f"upload of {name} returned {r.status}")

        done = call("PATCH", f"/v1/appScreenshots/{shot['id']}", {
            "data": {"type": "appScreenshots", "id": shot["id"],
                     "attributes": {"uploaded": True,
                                    "sourceFileChecksum": hashlib.md5(blob).hexdigest()}}})
        if done.get("errors"):
            die(f"commit failed for {name}", done)
        print(f"  ✓ {name}  ({len(blob):,} bytes)")

    # --- read back rather than trusting the writes -------------------------
    final = call("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots").get("data", [])
    print(f"  set now holds {len(final)} screenshot(s):")
    for s in final:
        a = s["attributes"]
        state = (a.get("assetDeliveryState") or {}).get("state")
        print(f"    {a.get('fileName')}  {state}")
    if any((s["attributes"].get("assetDeliveryState") or {}).get("state") == "FAILED" for s in final):
        die("Apple rejected at least one asset — check its dimensions against the display type")


if __name__ == "__main__":
    main()
