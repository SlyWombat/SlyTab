# Releasing the iOS app

App id **6794502588**, bundle `ca.electricrv.slytab`. Everything here is done
from the owner's machine: the App Store Connect signing key lives in `secrets/`
and is deliberately not in CI.

## The pages you actually need

| What | URL |
|---|---|
| App Privacy (the questionnaire) | `https://appstoreconnect.apple.com/apps/6794502588/distribution/privacy` |
| Version being prepared | `https://appstoreconnect.apple.com/apps/6794502588/distribution/ios/version/inflight` |
| TestFlight builds | `https://appstoreconnect.apple.com/apps/6794502588/testflight/ios` |

Apple reshuffles these paths. If one 404s, go to
[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **My Apps** →
**SlyTab**; App Privacy is in the left sidebar under General, and the version
is the **Prepare for Submission** entry.

## App Privacy — the answers

**This cannot be done from here.** The App Store Connect API does not expose it
at all: `appPrivacyDetails`, `appDataUsages` and `appDataUsagePublishState` all
return `404 PATH_ERROR`. It is web UI only, and it is mandatory before a first
submission — an unanswered questionnaire is the most likely cause of
`409 STATE_ERROR.ENTITY_STATE_INVALID` when adding a version to a review
submission, which is the opaque error Apple gives instead of naming the item.

What SlyTab collects, all **linked to identity**, all for **App Functionality**
only, and **none of it used for tracking**:

| Category | What | Why |
|---|---|---|
| Contact Info | email address, name | the account, and showing people who owes whom |
| User Content | receipt photos, profile photos | splitting a bill by item; the badge |
| Identifiers | user ID | the account |

No advertising, no analytics SDKs, no data brokers — see NFR-1 in
`docs/requirements.md`. Remember to press **Publish** afterwards; saving alone
does not clear the submission block.

## What is already done

Verified against the API on 2026-08-03, so do not redo it by hand:

- Build **15** attached and `VALID`, export compliance answered
  (`usesNonExemptEncryption: false`)
- All **six** 6.9-inch screenshots uploaded, delivery state `COMPLETE`
- Description, keywords, support URL, marketing URL, subtitle, privacy policy
  URL, Finance category, content rights declaration
- Age rating **4+**, including `socialMediaAgeRestricted`
- Review contact and the demo account (App Review must sign in — every expense
  belongs to a group of real people, so there is nothing to see signed out)
- Price schedule, **101 territories**, `availableInNewTerritories: false`
- `releaseType: AFTER_APPROVAL` — it goes live by itself once review passes

## Finishing the submission

Once App Privacy is published, either press **Submit for Review** on the
version page, or do it over the API:

```bash
V=eb06b1e9-ba39-47dd-ab7f-20bfc74cd1ff          # the 1.1 version record
R=$(scripts/ops/asc-api.sh GET \
      "/v1/reviewSubmissions?filter[app]=6794502588&filter[platform]=IOS" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])")

# 1. add the version to the submission
cat > item.json <<JSON
{"data":{"type":"reviewSubmissionItems","relationships":{
"reviewSubmission":{"data":{"type":"reviewSubmissions","id":"$R"}},
"appStoreVersion":{"data":{"type":"appStoreVersions","id":"$V"}}}}}
JSON
scripts/ops/asc-api.sh POST /v1/reviewSubmissionItems item.json

# 2. send it
cat > submit.json <<JSON
{"data":{"type":"reviewSubmissions","id":"$R","attributes":{"submitted":true}}}
JSON
scripts/ops/asc-api.sh PATCH "/v1/reviewSubmissions/$R" submit.json
```

## Screenshots

Captured by `.github/workflows/ios-screenshots.yml` — the real app in a
simulator on a GitHub macOS runner, because there is no Mac or iPhone here. See
`ios-6.9/README.md`. Upload with:

```bash
python3 scripts/ops/upload-screenshots.py docs/app-store/ios-6.9 --replace
```

**The 6.9-inch slot is `APP_IPHONE_67`.** There is no `APP_IPHONE_69` in the
enum; Apple kept one slot for the largest iPhone and it takes both 1290x2796
and 1320x2868. The obvious guess returns a 409 whose list of thirty valid
values is truncated by most tools before the useful part.

## Two things not to break

- **Do not point the listing's marketing or support URLs at slytab.com while a
  review is in flight.** The reviewer visits them, and electricrv.ca is what
  has been working. Move them after approval.
- **Build 15 predates the mobile work merged on 2026-08-03** — profile photos
  (#112), self-hosted servers (#113), the sheet keyboard fix. That was the
  owner's explicit choice, to start review immediately rather than wait for a
  new binary. Those ship in the next build; the issues stay open until then, so
  the "it's fixed, update your app" email is true when it goes out.
