# Manager access

Owner-approved shared four-digit PIN role for catalog, cartons, work history and dispatches. Owners retain connection, employee and access administration. The collector workspace link and no-login workflow are unchanged.

Manager entry: /?view=manager-login. Owner setup: Подключение → Доступ менеджеров. The owner can set/generate a PIN of exactly four ASCII digits, including leading zeroes, rotate it or disable access. Existing manager sessions are revoked on each change. Credentials are never returned by the settings endpoint, stored in logs or included in catalog commands. Stored credentials use a random salt and PBKDF2-SHA256; sessions are signed HttpOnly Secure SameSite cookies, valid for 30 days and bound to the current credential version.

Authorization is server-side, including direct API requests. Managers cannot retrieve worker access links, change passwords, create employees, restore legacy data, call RITM service dispatch routes or download private backup objects. Catalog/media/label maintenance and explicit carton/work/dispatch command allowlists are permitted. Catalog and operational audit actors contain manager device session IDs. A shared password cannot identify a human manager; individual attribution needs separate accounts later.

Failed logins are bounded in D1 by an HMAC of the trusted edge client address and a 15-minute window. Successful sign-ins release their own attempt reservation so a shared office network is not limited by legitimate users. No plaintext IP is stored.

Migration 0027 only adds two access tables. It does not rewrite supplies, stock, coefficients or historical work. Rollback to v46 leaves those tables unused and preserves collector/owner access.

17 November follow-up: owner setup now accepts exactly four numeric characters. Existing hashed passwords and sessions remain valid until the owner saves a new PIN; deployment never assigns an unsolicited code or changes credentials. Login retains legacy password compatibility during this transition. The PIN uses the same salted PBKDF2 and persisted attempt limits.
