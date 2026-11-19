# Article catalog migration

The catalog belongs exclusively to the owner-private Assembly v2 Site. No Google workbook, Apps Script deployment, old RITM API or old database is written. The two user-supplied Excel workbooks are migration inputs, not live dependencies.

## Sources and identity

- БАЗА FBO.xlsx, 6,621,153 bytes, SHA-256 `5576b35b69a87e0dc0dd11563d26913afc23939a1b278cc9c3552ccaf2928d00`.
- Картинки  (2).xlsx (two spaces), 2,713,236 bytes, SHA-256 `2405812115ec1b971f6ce3faa33e00eebf8eca84503322614eeaf5a4df9c61ff`.

WB: 2,546 source rows → 2,541 marketplace/store/article cards. OZON: 1,426 → 1,388. Total: 3,972 source rows, 3,929 cards. These are marketplace listings, not a claim of 3,929 distinct physical products. Duplicate groups retain every raw source row and cell reference. Formula-only filldown rows are excluded. Excel formula caches and literal error strings are read as data, never evaluated. Error values do not become zeros. Barcodes remain strings; numeric scientific notation is expanded to an integer string.

Product identity is `(marketplace, exact store, normalized primary article)`. Only trim, NFC and case normalization are used. Explicit Excel A/B aliases are indexed separately. There is no automatic `(OZ)` removal. Supply matching is scoped to exact marketplace/store, prefers a primary article and rejects ambiguous aliases. RITM's source supply/position IDs, department and barcode remain authoritative and unchanged. An unknown source store is not guessed from another listing.

## Conflicts and history

The user's comment that OZON may be more correct is a reference preference, not a blanket overwrite rule. Each market keeps its own barcode, packaging and capacity. The only explicit user override is **OZON, SS0031.A7484(OZ), store 1: 700 units**, confirmed 13 November 2026. Its original row 27 still says `700` and `550 М`; both original cells are preserved. The other **41 source-row capacity mismatches** remain unresolved. Additionally, missing norms and duplicate-row disagreement leave **44 effective cards** without a confirmed norm. Recording work is allowed; allocation requires a known positive norm.

Every new supply position records the matched catalog import/entry and the effective capacity. The incoming source payload signature is calculated before catalog enrichment, so replaying the same RITM version still works after a catalog refresh. Later catalog updates do not rewrite existing position norms, allocations, work, exports or sent-dispatch snapshots. Existing positions are not silently relinked. The selected-supply snapshot remains ten bounded SQL statements, with an indexed catalog JOIN; it never downloads the entire catalog.

## Durable storage and import

Structured cards, aliases, photo links, source rows and provenance live in the separate Cloudflare D1 database. Original Excel copies and a bounded photo cache live in private R2 (`BUCKET`). No new dependency was added. Owner management offers Excel preview, server search/filter/pagination, source download and card/source-row review. The collector keeps its established layout, including the right supply list. Product/box type and photo are shown only when a position has a confirmed catalog match.

Parsing uses the existing ExcelJS in a separate browser Web Worker, loaded only during catalog import. The ordinary collector path does not parse spreadsheets or read Google. An import is content-addressed by manifest/hash, staged in 50-record chunks (443 chunks for these inputs) and resumable. Each chunk has a checked SHA-256 and immutable receipt. Atomic activation requires every chunk, matching entry/photo/source-row counts, valid photo references and both archived originals. Activation uses the existing revision-guarded command transaction, so concurrent supply planning retries on the new catalog revision. No partial catalog becomes visible. Previous immutable versions are retained; reimporting a prior source can restore the active reference without rewriting historical positions. This is an explicit owner action, never automatic rollback of stock.

Local tools: `scripts/prepare-catalog.ts` reads the two Excel files into an ignored `.local/` bundle. `scripts/transfer-catalog.ts` uploads that bundle and original files through the same API, using a token only through hidden stdin. It refuses any destination other than this v2 Site or the local preview. No secret or workbook content is printed or committed. Both original files remain unchanged.

## Photos and limits

The photo file contains **18,189 distinct article names / 18,194 article-store records** and **116,514 distinct gallery URLs**; it contains no embedded images. All article-store metadata and galleries are retained. 3,915 of the 3,929 grouped cards have a matched primary photo; the remaining 14 are explicitly marked. A unique identical photo may be reused across stores only through an explicit source article, while product data stays separate.

Images are fetched only from stored HTTPS WB basket CDN URLs, through the private app endpoint. No arbitrary URL proxy, redirects, SVG, credentials or custom host/port are accepted. Responses have a timeout, image MIME allowlist and 1 MB streaming limit. The first 256 distinct successfully fetched images may be cached, using atomic D1 slot reservations: at most 256 MB of image objects, plus original Excel archives. When slots are full, photos still load from their source without enlarging the cache. Photo failure shows a fixed-size placeholder and never blocks work. This budget bounds image storage; it is not a promise that every provider quota can never be reached.

All 116,514 gallery image files have **not** been mirrored. Uncached images still depend on the public CDN. If the CDN rejects the cloud server or its response cannot be cached, the photo endpoint redirects only to the already validated source URL with no referrer; the browser loads that public asset directly. Service-token verification tools never forward their private authentication header to that CDN. Full independent media migration requires measuring actual size and agreeing a storage budget. These Excel files contain product packaging and machine-type assignments, **not labor/payroll norms or a complete physical equipment register**. Those absent facts are never invented. Automatic RITM delivery and employee role access remain separate cutover work.
