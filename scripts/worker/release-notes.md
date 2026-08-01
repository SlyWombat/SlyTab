---
build: 14
version: 1.0.7
issues: 110
---
The iPhone version of SlyTab has just been updated.

Install or update it here: {{TESTFLIGHT_URL}}

Open that on your iPhone. If you do not have TestFlight yet, the link will
send you to install it first, then bring you back to SlyTab.

What is in it:

  - Groups open faster. Opening one was quietly asking for the same list of
    expenses several times over, and each extra request cost a full round trip
    to Canada — which is why it felt slow from further away. It now asks once.
  - A group you have opened before appears straight away, showing what it
    looked like last time while the current figures load behind it. You should
    not be watching an empty screen for data we already had.
  - Scanning a receipt with no printed total on it — a card statement, a faded
    till roll — used to leave the amount at zero and say nothing, as though the
    scan had failed. It now adds up the lines it did read, fills that in, and
    tells you that is what it did. Worth checking against the receipt, since
    anything it failed to read is missing from that number too.
  - A group with no expenses in it can now be deleted outright, instead of only
    being archived. Archiving is right for a group with a history; it was never
    right for one created by accident.

If anything is wrong, please tell us from Profile -> Report a bug.

- SlyTab
