# SPL website package — NEKpay Deposit integration scaffold

## Package contents
- `user-panel/index.html` — existing SPL user interface (design preserved)
- `user-panel/server.js` — existing user backend, with WPAY Collect/Notify endpoints removed and NEKpay endpoints reserved
- `admin-panel/admin.html` — existing admin interface
- `admin-panel/server.js` — existing admin backend
- Withdrawal implementation was not intentionally changed.

## Important: Deposit is NOT live yet
The official NEKpay Collect API URL, exact request fields, response fields, callback fields/status values and callback signature verification contract were not available in the materials supplied. Therefore this package intentionally returns:
- `503` from `/api/nekpay/collect`
- `501` from `/api/nekpay/notify`

This fail-closed behavior prevents unverified callbacks from adding money to Firebase. Do not enable real deposits until the official API specification has been mapped into these two endpoints and tested with NEKpay's test account.

## User service environment
- `PORT` (provided by host)
- `PUBLIC_URL` (public URL of user service; callback URL will be `PUBLIC_URL/api/nekpay/notify`)
- `NEKPAY_MCH_ID=808258224`
- `NEKPAY_API_URL` (official Collect API URL; not yet known)
- `NEKPAY_PAYMENT_KEY` (secret; set privately in host environment, never commit/share)
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (use literal `\n` for line breaks) OR `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FIREBASE_DATABASE_URL=https://splora-7abad-default-rtdb.asia-southeast1.firebasedatabase.app`

## Admin service environment
- `PORT` (provided by host)
- `ADMIN_UIDS` (comma-separated Firebase Auth admin UIDs)
- `USER_DATABASE_URL=https://splora-7abad-default-rtdb.asia-southeast1.firebasedatabase.app`
- `FIREBASE_PROJECT_ID=splora-7abad`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` OR `FIREBASE_SERVICE_ACCOUNT_JSON`

## Deployment layout
Deploy `user-panel` and `admin-panel` as separate Node.js services:
- Build command: `npm install`
- Start command: `npm start`
- Root directory: corresponding folder

## Known limitations inherited from supplied project
- Live Firebase/hosting credentials and database rules were not available, so no production deployment or end-to-end test was possible.
- Review Firebase RTDB security rules before going live. The supplied setup notes describe legacy browser-side/plaintext-password flows and direct Firebase access; those need a separate security review.
- Keep a full Firebase database backup before deployment.
- Do not paste merchant payment key, Firebase private key, passwords or Google Authenticator codes into chat.
