# Arkady message presentation

The owner approved the light notification mockups and bright green olive detail on 13 November 2026. `worker/cloud/arkadyCards.js` owns the presentation DTO and its native Bitrix ATTACH adapter. No HTML renderer, extra bot, webhook permission, database migration or new external service is introduced.

## Supported notifications

- New supply and appended goods: distinct headings, actual verified department counts/quantities, the manager and one link to each relevant production sheet.
- Stock assignment: destination, individual article/quantity rows and links only to participating stock sheets. The raster card shares a 16-row budget between departments; native fallback cards start at 40 rows per department and reduce that limit when needed to fit the endpoint. Retain full totals and explain that the rest are in the linked sheet. The durable DTO retains all entries.
- Stock completion: one notification per verified upload, only when **every** accepted article is printed **and** cut, including both departments when the upload was split. Show article/added-quantity rows under their department using the same display budgets, link the exact participating stock tabs, and retain manager/praise. Separate uploads on the same destination tab remain independent; a one-article upload is one complete batch too. Supply completion keeps its existing department policy. Both use green ✅ and never claim packing/shipping.
- Existing urgent reminders: same trigger, selected department and configured humor; visual warning presentation only.

The primary transport uploads the complete raster card with a links-only caption. If preparation fails before any send, the existing `imbot.message.add` transport receives a structured ATTACH with IMAGE, GRID, MESSAGE and DELIMITER blocks. Its outside MESSAGE is only the bot label; source links are the final card blocks, after the joke. Link values remain clickable. The public decorative PNG contains no production data or credentials. Bitrix controls native client fonts, layout and supported colors; local preview is a content/layout approximation, not a screenshot of a message sent to the portal. Text in attachment values deliberately avoids BB-code formatting because mobile clients may display unsupported tags literally.

`public/images/arkady-notification-v2.png` is the approved photographic header: a large vivid green olive branch with olives on white and the RITM wordmark. It replaces the previous small stylised decoration for new sends; the v1 asset remains available for already delivered cards. The image has a 3:1 aspect ratio, declared at 642 × 214 in the native attachment. It contains no operational text. Completion lists use bounded name/quantity rows with a remaining count and full-source link. The client ultimately determines attachment width; no unsupported CSS or forced chat-width setting is sent.

## Preserved operational rules

Supply readiness decisions, schedules, one-time historical exclusion, delivery claims, ambiguous-result handling, source/department matching and phrase history/cursors remain unchanged. The stock correction below changes notification grain while preserving legacy history. Formatting is pure and never advances a humor sequence. DTO and legacy text are recorded together at the existing queue point. Old queued events use their original text unless explicitly superseded by the stock batch policy below; no historical notification is requeued. A possibly accepted send is never retried merely to change presentation. The transport keeps its existing method/authentication and shared-chat selection.

The 13 November batch correction supersedes stock's earlier per-position notification grain. `stockNotificationBatches` derives exact membership from the complete verified StockOperations manifest, not the bounded seven-day history page. Missing/unknown/older-plan source data blocks the whole upload. Verified archived members count as completed. Readiness is conservative against the whole current position plan; overlapping later additions cannot be assigned to a specific work event, so they can delay a batch rather than trigger an early completion. Messages report the upload's quantities rather than another upload's accumulated plan.

`arkadyStockBatchWatchStatesV1` and `arkadyStockBatchWatchStartedAtV1` keep upload completion state without deleting legacy position-watch history. Already finished historical uploads initialise silently; existing unfinished uploads continue tracking. The event ID is `stock-batch:<operation-id>:complete`, persisted atomically with state/praise under the existing store lease. Pending legacy per-position completion notifications become `superseded` before draining; sent, sending and uncertain records stay untouched and are never replayed. Notification enablement is rechecked before every next claim. No Google cells, work logs, production quantities, chat settings or schedules are changed by this correction.

Attachments are bounded below the existing legacy endpoint's 30 KB limit. The native adapter reduces only displayed article rows before sending when long names make a card too large, preserving its exact totals and links. Unsupported historical records retain their original text; no second network request is attempted.

## Verification boundary

Owner-only connection, notification enablement and humor settings save independently of long production operations. `worker/cloud/bitrixSettings.js` atomically writes only the corresponding preference row; encrypted connection changes compare against the exact prior configuration so a slow chat-membership check cannot overwrite another owner's edit. Production leases, outbox claims, phrase cursors and job/work history are never cleared or bypassed. No schema or runtime-secret changes are needed. A delayed settings refresh cannot replace a newer saved value in the settings screen.

Tests use isolated scopes, fake source data and injected fake transports. Browser screenshots come from the actual queued ATTACH payloads rendered locally at desktop and phone widths. No test notification is sent to the real Bitrix portal or shared chat, and no production job, stock, work event or coefficient is written. Portal-specific final rendering remains unverified until a real authorised business notification is viewed.

13 November batch verification: 77 notification/stock/lease tests, 60 Sites tests and 39 cloud/authentication tests passed. Typecheck and production build passed. Six isolated browser checks covered assignment, stock assignment and completion at 1100px and 390px, including exact links and no horizontal overflow. The mixed-department integration test uses LocalD1, reloads CloudStore after a fake acknowledged send, and verifies no duplicate delivery or source change. No real-chat request was made.

## Header asset provenance

Generated with the built-in image generation tool, using the v1 header as the edit target and the approved full-card mockup as the botanical reference. Saved as `public/images/arkady-notification-v2.png` (2172 × 724); the generation result was copied unchanged. The former asset remains intact.

Final generation prompt:

```text
Edit target image 1 into a finished production asset for the RITM notification header. Image 2 is the approved visual reference ONLY for its beautiful realistic olive branch. Output ONLY a wide horizontal rectangular header banner, ratio 4:1, intended 1280x320 pixels. Solid clean white background, no screenshot UI, no rounded card border, no chat avatar. On the left, preserve the precise brand wordmark 'RITM /' in bold dark navy sans-serif with a teal forward slash, at a prominent readable size, occupying the left 28% of the banner, vertically centered, with generous safe margins. REMOVE the small Russian caption ПРОИЗВОДСТВО. The right 38% must contain a LARGE photorealistic lush olive branch entering from the top-right and hanging diagonally toward the center, just like the branch in reference image 2: vivid fresh emerald and bright green long waxy leaves, several glossy lime-green olives, fine realistic veins, delicate highlights and tiny dew drops, natural thin woody stems, a subtle soft studio shadow on white. This must be a premium photographic botanical image, NOT a vector illustration, NOT an icon, NOT muted sage or grey. Make the branch visually substantial and at least 85% of banner height so it remains recognizable when reduced in a chat message. Keep the middle area calm white and the logo unobstructed. No additional text, numbers, data, emoji, completion heading or ornament. Crisp studio lighting, refined corporate premium finish.
```

Official protocol references:

- [Existing bot message endpoint](https://apidocs.bitrix24.com/api-reference/chat-bots/outdated/messages/imbot-message-add.html)
- [Attachment schema](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/messages/attachments/index.html)
- [GRID pairs and links](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/messages/attachments/block-collections/grid.html)
- [Image preview](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/messages/attachments/block-collections/images.html)

## Complete raster cards (owner-approved 13 November)

All automatic presentation scenarios now share the full-card renderer: new supply, appended goods, normal/urgent stock assignment, existing supply reminders, supply completion and whole-upload stock completion. The owner settings test also uses it. Historical greeting/plain legacy records are not rewritten or replayed.

`worker/cloud/arkadyCardImage.js` renders directly in the Cloudflare Worker using public versioned glyph masks, RGB compositing and native Compression Streams. There is no production browser, native/WASM dependency, extra hosting service or third-party render request. The cache contains only decoration and glyphs, never business data. Completed images stay in memory and are uploaded straight to Bitrix.

The subject is now a wide 36px bold panel at 1000px export width, including `Запасы · Срочные 2 этаж`. The remaining scale is 50px heading, 36px department/quantity, 32px body, 42px total and 28px notes. Golos Text is licensed under OFL; its attribution is in `public/images/arkady-font-OFL.txt`. The application UI font remains unchanged. `scripts/generate-arkady-render-assets.mjs` recompiles the committed static atlas from the official Golos Text TTF using an explicitly supplied local Playwright module. Run it only for deliberate artwork changes; ordinary builds require neither font downloads nor a browser. The atlas records the source font and compressed content SHA-256.

The existing single-send boundary chooses `imbot.v2.File.upload` for raster cards. Following the owner's approval of the corrected private example on 16 November, `fields.message` carries only BBCode links to the same verified source tabs for EVERY supported scenario. It never repeats the subject, article list, quantities, totals, manager or joke, including for long lists. File and links belong to ONE message. Do not place fake clickable links in the PNG. Large uploads retain all quantities and members in the durable DTO. A shared 16-row image budget lets the approved ten-article upload fit entirely; longer lists retain their exact total, show the remaining count in the image and point to the full source through the links below.

After Bitrix acknowledges the file's message ID, the existing cosmetic update reapplies that same links-only caption with `urlPreview: 'N'` to suppress Sheets previews. Failure of that update never changes an accepted delivery into a resend. This format change does not rewrite or resend existing messages, change chat settings, consume phrases or touch production source data.

Before the first Bitrix call, an unavailable/corrupted atlas or oversized layout safely falls back to the existing native card. After the file request begins, a timeout, invalid acknowledgement or HTTP error is uncertain and NEVER triggers another native/image send. Confirmed image receipts persist message ID, file ID and `card-image-v1` in the original operation record. Sent/sending/uncertain history and joke/praise cursors remain intact. No new queue, production data write, polling job or schedule change was introduced.

Verification command: `npm run test:arkady`. Raster tests decode actual PNGs, check large readable subjects, exact totals/captions, 500-item upload handling, static asset caching, wrong/missing file acknowledgements, uncertain retries, persisted receipts, and the actual Cloudflare runtime through Miniflare with isolated synthetic data and transport. No shared-chat test is permitted. An owner-requested private example is a separate bounded send, explicitly labelled as an example.

Official API: https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/files/file-upload.html
