# Questions people actually ask

Short answers. The [manual](./) covers each screen properly.

---

## Getting started

**Do I have to install anything?**
No. SlyTab runs in any browser and works on a phone that way. There are
iPhone and Android apps if you prefer one, and the same account works
everywhere.

**Does everyone I split with need an account?**
No. You can add someone by email before they have signed up, and their share
is tracked from that moment. They get an invitation and can join whenever
they like — or never, and you still have accurate numbers.

**It costs nothing? What's the catch?**
There isn't one. SlyTab was built for the author's family and friends and is
shared as-is. There is no premium tier, no ads, and no analytics collecting
anything about you.

**I already use Splitwise. Can I bring my history?**
Yes — import a group directly, mapping their members onto people you already
know. Anything already in SlyTab is skipped rather than duplicated.

---

## Money and splitting

**Can more than one person pay for the same expense?**
Yes. Who paid and how it is split are separate questions. If you put £60 on
your card and Alice put £40 on hers, record both.

**How do I split something unevenly?**
Five ways: equally (optionally excluding people who were not there), by exact
amounts, by shares (2 : 1 for the double room versus the single), by
percentage, or equally with a plus-or-minus adjustment for one person.

**Someone shared only the starter. Can I split by item?**
Yes. Scan the receipt and assign each line to whoever had it.

**Why does the app tell Alice to pay me, when Alice owes Ben?**
Because it is fewer payments for the same result. If Alice owes Ben and Ben
owes you, SlyTab skips the middle step. Nobody ends up better or worse off.

**Does SlyTab move money?**
No. It records that money moved. You pay each other however you already do —
your Interac, PayPal.Me and Venmo handles sit on your profile so people can
find them.

**Someone handed me twenty dollars towards what they owe. Can I record that?**
Yes. Tap their balance and record what you were actually given — part of a
debt is fine, and the rest stays on their tab. A payment you record as the
person who *received* it counts straight away; there is nobody left to
confirm it to. If you get the amount wrong, either of you can delete it.

**Can I ask someone for what they owe?**
Once the group is locked for settling up, yes — tap their balance and
**Remind**. It sends one email. It will not send another for a few days, and
it will not send at all to someone who has turned off SlyTab emails, in which
case it tells you so rather than pretending.

---

## Several currencies

**What happens when a group spends in more than one currency?**
Each expense keeps the currency it was paid in. The group has a home
currency, and anything foreign converts at the reference rate for the **date
of the expense**. That rate is then stored on the expense.

**Will my balance change later?**
Not on its own. Nothing re-values your history in the background, which is
the point of storing the rate. If you edit an expense, saving re-reads the
rate for that date — and a rate you had overridden by hand needs entering
again.

**My card gave me a worse rate than the official one.**
Override it. Enter the rate you were actually charged and SlyTab uses that.

**Do currencies without decimal places work properly?**
Yes. Chilean pesos, yen and won are handled as whole units throughout. A
receipt total printed as 88.930 CLP is eighty-eight thousand nine hundred and
thirty, and SlyTab reads it that way rather than as 88.93.

---

## Receipts and privacy

**Where do my receipt photos go?**
To our own server, which runs the model that reads them. No third-party
vision service is configured, so receipts do not leave it.

**Do you strip the location from my photos?**
Yes, from JPEG photos when they arrive. The phone app also reads the photo's
location *before* uploading, but only to guess which currency you paid in.

**Do you track me?**
No. There is no analytics SDK, no advertising identifier and no crash
reporter in either app. The app talks to our server and, if you enable
notifications, to Apple's or Google's push service.

**What if the scan gets a total wrong?**
Correct it — the scan fills the form in, it does not have the final word.
Please report it with the photo attached, so it can be added to the test set.

---

## Groups and people

**How do I get someone into a group?**
Three ways: pick them from people you already share a group with (one tap, no
email), send a share link that works for seven days and can be revoked, or
invite by email.

**Can I leave a group?**
Yes — open it, tap its name, then Leave this group. You are asked to settle
up first if you still owe or are owed. Your past expenses stay so nobody
else's balance moves.

**We have stopped spending but not finished paying each other. Now what?**
Lock the group for settling up, from group settings. A locked group takes no
new expenses, so the balances hold still while everyone pays — payments,
reminders and someone finally accepting an old invitation all still work.
Anyone in the group can unlock it when the forgotten receipt turns up.

**What happens to a group we have finished with?**
Archive it, once everyone is square. It becomes read-only — payments included
— and collapses out of the way, keeping its history so old balances stay
honest.

**Can I use a photo instead of my initials?**
Yes, in Profile. You pick the crop, and it is shown to the people you share a
group with.

**Can I point the apps at my own server?**
Yes. SlyTab is self-hosted software, and the phone apps have a setting for
which server to talk to. Most people will never need it.

---

## Your account

**Can I get my data out?**
Yes — export any group's full history as CSV from the group screen on the web
app.

**How do I delete my account?**
Profile → Delete my account. You type your email to confirm. Your personal
details go; your share of shared expenses is anonymised so nobody else's
balance changes. If you signed in with Apple, we tell Apple to revoke that
too.

**I found a bug.**
Profile → Report a bug. It arrives with your app version attached, and you
get an email when it is fixed.
