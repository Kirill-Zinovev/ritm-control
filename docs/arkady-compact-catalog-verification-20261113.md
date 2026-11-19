# Compact Arkady cards and catalog routing verification

## Changes

The production renderer preserves the approved 50/36/32px text and green olive artwork, reduces vertical gaps and aligns ordinary department counts on the heading row. A representative two-department supply with manager and two-line joke is 1000×658px. Stock cards still list exact articles and quantities, show a green completion check and preserve whole-upload completion. Normal captions contain only one link row. Long uploads retain their complete selectable list and exact totals.

Bitrix File.upload creates one message. Because its documented fields do not support urlPreview, a confirmed upload is followed by one update of that same message with urlPreview=N. This does not create another notification. Cleanup is best effort: a failed cleanup cannot change a confirmed receipt to uncertain or cause a resend. Sources: https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/files/file-upload.html and https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/messages/chat-message-update.html .

`production-xerox-routing.md` records the X invariant, white-UV label compatibility and two owner-approved catalog corrections. Fresh, read-only connector ranges were passed to the actual routing function: WT0013.A0214 routes roll/2-GO/CBI; KT0028.A7387 routes roll/УФ/CPB (the catalog machine was changed to УФ while this task was running); CT0001.A7333 routes box/XEROX/X. Test quantities are not production jobs. Neither job membership nor history was changed.

## Checks

- TypeScript: passed.
- Production build: passed; the existing large bundle warning remains.
- Related supply, stock, single/bulk transfer, Arkady readiness/delivery and rendered-PNG suites: 238 passed.
- Domain suite: 62 passed.
- Sites, printing and Assembly API suites: 60 passed.
- Compiled cloud transfer controller: 45 passed.
- Actual Node and isolated Worker renderer verified PNG dimensions, bounds, prominent subject, links, fallback and uncertain-result behavior. Both compact supply and stock completion PNGs were visually inspected.
- git diff --check: passed.

## Existing verification limitations

The broad intelligence command without the synthetic environment fails to initialize 18 test modules because private production/test IDs are absent. With the existing synthetic preload, 381 pass and four fail: a roll registry fixture assertion, two test-writer isolation fixture/configuration checks, and a roll-order calculation-error fixture. The exact same four failures were reproduced on a separate clean extraction of published commit 16181662576d24b2304c1d2d5165e2c56e5fb24f (version 194). No production test-write access was enabled to bypass isolation.

The strict premium UI audit reports 19 findings in existing application components. A clean version-194 audit has the same 19 findings, with zero additions. This task changes generated notification artwork, not those application workflows. No user mouse/browser control or shared-chat test messages were used.
