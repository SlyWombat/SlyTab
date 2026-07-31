# Why SlyTab

Honest differences, each one checkable in the code. Where the alternatives are
better, this says so — a comparison that only flatters is one nobody believes
twice.

<!--COMPARISON-->

| | SlyTab | Typically elsewhere |
|---|---|---|
| **Exchange rates** | Fixed to the day of the expense and stored on it, so a balance never drifts on its own — nothing re-values your history in the background. Editing an expense re-reads the rate for that same date, and a rate you overrode by hand needs entering again. | Conversion is a bulk action over past expenses. Splitwise warns that it affects settled ones and can move other members' balances, and that new expenses need it re-running. |
| **Receipt scanning** | Read by a model on our own server. No third-party vision service is configured, so receipts do not leave it. Location data is stripped from JPEG photos on arrival. | Usually a third-party vision API, with the photo leaving the vendor's control. |
| **Tracking** | None. No analytics SDK, no advertising identifier, no crash reporter. The app talks to our server, and to Apple's or Google's push service if you turn notifications on. | Analytics and crash SDKs are close to universal. |
| **Deleting your account** | In the app, in two taps. Your share of shared history is anonymised so nobody else's balance moves, and Apple is told to revoke the sign-in. | Often a web form or an email request. |
| **Money handling** | Integer minor units with per-currency scale everywhere, so zero-decimal currencies like CLP and JPY are never a rounding accident. | Varies; floating-point money bugs are a common complaint. |
| **Price** | Free. No premium tier holding a feature hostage. | Currency conversion, receipt scanning and charts are common paid upgrades. |
| **Where they are ahead** | Smaller and younger. No per-currency balance view, no recurring expenses, no web-wide integrations. | Mature, large user base, and most people you invite will already have an account. |

<!--/COMPARISON-->

## The rate thing, in more detail

This is the difference that matters most and is easiest to miss.

When you enter an expense in a foreign currency, SlyTab looks up the reference
rate **for the date of that expense** and stores it on the expense. From then
on, that expense's contribution to everyone's balance is fixed.

The alternative — converting on the fly, or converting the group's history in
one action — means a balance you agreed to last month can be a different
number today, through no action of yours. Splitwise's own documentation warns
that converting "affects all expenses, including settled ones" and "may impact
other members' balances".

Ours cannot do that, because there is nothing to re-run.

The honest caveat: **editing an expense re-reads the rate for its date**, so a
rate you overrode by hand must be entered again if you edit that expense
later. Same date, so the automatic figure is unchanged — but a manual
override is not remembered through an edit.

## What "no third-party AI" actually means

Receipts are read by a self-hosted model. The code does contain a path to a
third-party service, and it is selected only when no local model is
configured — production configures one, and ships with the third-party API key
empty.

So: no receipt has been sent to a third party, and none can be while the
service is configured as it is. That is a stronger claim than most apps can
make and a weaker one than "impossible", and the difference is worth stating
rather than glossing.

## What we do not do

- **Move money.** SlyTab records that a payment happened. You pay each other
  however you already do.
- **Charge.** There is no paid tier, so no feature is withheld.
- **Track you.** No analytics, so no dashboard of your behaviour exists to be
  breached or sold.
- **Guess.** Where a number is approximate — a total converted from several
  currencies — it is marked approximate rather than presented as exact.
