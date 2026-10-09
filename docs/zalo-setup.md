# Zalo setup

The Zalo adapter checks **Vietnamese numbers only** (`+84`). Numbers from other countries are reported as `skipped` and never reach Zalo.

It uses [`zca-js`](https://github.com/RFS-ADRENO/zca-js), an **unofficial** client that behaves like Zalo Web. Zalo offers no official "is this number registered" API.

## Risks you accept

- **Account ban / restriction.** Automated lookups through a personal Zalo account violate Zalo's terms. The account can be rate-limited, restricted or locked. Use a dedicated account, not your main one, and keep volume low (the default daily cap is conservative; raise it only after observing the account's behavior).
- **Protocol breakage.** `zca-js` reverse-engineers Zalo Web and can stop working when Zalo changes it. `package-lock.json` locks the tested version; update deliberately and re-run a staff pilot.
- **Credential sensitivity.** The saved cookie grants full access to the Zalo account. Treat `data/` as secret and never commit it.

## Login

```sh
phone-app-checker login zalo --account <name>
```

1. The adapter draws the login QR **in the terminal** (explicit black-on-white colours, readable on dark and light themes). zca-js delivers the QR only as a PNG (`data.image`); `src/qr-png.ts` reads the module grid out of that picture and redraws it, so no file is written. If the window is too small for the code you get an "enlarge the window / Cmd+minus" message and the code appears once it fits.
2. In the Zalo mobile app tap the QR scanner icon, scan the code, then confirm on the phone. The terminal says `QR code scanned` when Zalo reports the scan.
3. An expired QR (about 100 s) is replaced by a new one, marked `New QR code (#n)`, up to 3 times, then the login ends with an error; a declined login aborts.
4. Only when the picture cannot be read as a QR does the adapter fall back to the old behaviour: it saves `login-qr.png` in the account's private directory (mode `600`), prints its path and, on a macOS terminal, opens it. That file is deleted when login finishes (success or failure).

Credentials are saved to `credentials.json` in the account directory (mode `600`, directory mode `700`): `cookie`, `imei`, `userAgent` and the language (`vi`). Subsequent runs restore them with no QR. No profile fields (name, avatar, uid, ...) are stored.

If the stored session is rejected (logged out on the phone, session expired, account blocked), the account is marked unusable and you must run `login zalo` again.

## What a lookup does

For each number the adapter makes one `findUser` request with the number in international form without `+` (e.g. `84901234567`). Only whether a user was returned is used; the returned profile is discarded. Nothing is sent to the contact and no friend request is made.

Phone numbers are masked in logs.

## Result mapping

| Zalo response | Status / signal |
| --- | --- |
| User resolved (uid present) | `yes` |
| Error code `216` | `not_found` |
| HTTP 429 | `RateLimited` (account cooled down; uses `rateLimitCooldownMs`) |
| HTTP 401 / 403, or login rejected when restoring the session | `AccountBanned` (re-login required) |
| Any other error (network, parse failure, unrecognized code, response without error or uid) | error, **not** converted to `not_found`; handled by the runner's error cooldown |
| Number not matching `+84` + 8–10 digits | left out of the batch result, reported `unknown` |

Error code `216` is the only code zca-js documents for "no result" (its `findUser` special-cases it). The throttle and expired-session signals come from HTTP status and login failures; Zalo's own throttling error codes are not documented, so they are not guessed. If you observe a new code during a pilot run, add it to `src/adapters/zalo.ts` explicitly.

## `not_found` is not proof of "no Zalo account"

Zalo lets users disable **"Allow strangers to find me by phone number"**. For such users the response is the same `216` as for an unregistered number. A `not_found` therefore means **"no discoverable account"**: it may be an unregistered number or a privacy-hidden one. The adapter cannot tell them apart.

## Limits

- Zalo restricts how many strangers a free account can look up or interact with, and the exact limit is not published. Keep `dailyCap` low at first and increase it gradually while watching for `RateLimited` or `AccountBanned`.
- One account is used at a time; additional accounts spread load but each carries its own ban risk.
