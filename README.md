# Guild hall

The finished guild hall from Deeper Than Code, Unit 4, sessions 4-13 and 4-14. One Express process: accounts sealed with a JWT, an inbox and outbox between them, a catalog of potions, weapons, and armor, and a pack of holdings whose quantity cannot go below zero. The page in `public/` is the same hall served from the same process.

Live: https://guild-hall-production.up.railway.app/

Build yours first. Open this one when a status disagrees with the session's list.

## Run it on your machine

```bash
npm install
cp .env.example .env     # then set JWT_SECRET to something long and random
node --env-file=.env server.js
```

`.env` holds the four names the session uses:

| Name | What it is | Default |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | none; required |
| `JWT_SECRET` | the signing secret | none; required |
| `PAGE_ORIGIN` | the origin `cors` allows | `http://localhost:5173` |
| `PORT` | the port Express listens on | `4100` |

The database is `guildhall`. On Railway the MongoDB service injects `MONGO_URL` instead of `MONGODB_URI`, so the server reads `process.env.MONGODB_URI ?? process.env.MONGO_URL`. That URL names no database, so the server connects with `dbName: 'guildhall'` when the path is empty. Railway also sets `PORT`. Do not commit `.env`.

Passwords are hashed with `bcryptjs`, which has the same `hash` and `compare` calls as `bcrypt` and no native build. Everything else is what the session names: `express`, `mongoose`, `jsonwebtoken`, `cors`.

## Models

- `User` — `name`, `email` (unique, lowercase, trimmed), `passwordHash`. The hash is on no response.
- `Message` — `sender` and `recipient`, both refs to `User` and indexed, `body` up to 2000 characters, timestamps. One letter, one name on the front: one-to-many from each user.
- `Item` — `name`, `kind` in `potion`, `weapon`, `armor`. No quantity. The catalog says what a thing is.
- `Holding` — `owner`, `item`, `qty` (min 0), unique on the pair. The join. The number lives here.

## Routes

Every route under `/api` answers JSON, and every error is `{ "error": "..." }`. Routes marked with a token need `Authorization: Bearer <token>`; the token's `sub` is the user id and its audience is `guild`, checked on sign and on verify.

| Method and path | Token | Body | Answers |
|---|---|---|---|
| `POST /api/register` | | `{ name, email, password }` | 201 `{ id, name, email }`; 400 missing field or password under 8; 409 email taken |
| `POST /api/login` | | `{ email, password }` | 200 `{ token, id, name, email }`; 401 invalid credentials |
| `POST /api/messages` | yes | `{ recipient, body }` | 201 the message; 400 empty body or self; 404 no such account |
| `GET /api/inbox` | yes | | 200 messages to you, newest first, `sender` populated to `name` |
| `GET /api/outbox` | yes | | 200 messages from you, newest first, `recipient` populated to `name` |
| `GET /api/messages/:id` | yes | | 200 for the recipient; 403 for the sender or anyone else; 404 unknown id |
| `POST /api/items/seed` | yes | | 201 the three items when the catalog is empty; 200 the existing items otherwise |
| `GET /api/items` | yes | | 200 the catalog, no quantities |
| `GET /api/pack` | yes | | 200 your holdings, `item` populated |
| `POST /api/pack/give` | yes | `{ item, amount }` | 201 the holding; 400 bad amount; 404 unknown item |
| `POST /api/pack/spend` | yes | `{ item, amount }` | 200 the holding; 400 bad amount; 404 unknown item; 409 not enough |
| `POST /api/pack/transfer` | yes | `{ item, amount, to }` | 200 `{ yours, theirs }`; 400 bad amount or self; 404 unknown item or account; 409 not enough, and no credit runs |

The id in the register and login bodies is the one small addition to the session's contract: it is what a second account pastes into `recipient` or `to`.

The live example also seeds the catalog on startup when it is empty, so a visitor sees three items without curl. On your machine, `POST /api/items/seed` with any token does the same thing.

## The walkthrough from the session

```bash
H='Content-Type: application/json'
U=http://localhost:4100

curl -s -H "$H" -d '{"name":"Bran","email":"bran@example.com","password":"a-long-password"}' $U/api/register
BRAN=$(curl -s -H "$H" -d '{"email":"bran@example.com","password":"a-long-password"}' $U/api/login | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X POST -H "Authorization: Bearer $BRAN" $U/api/items/seed
curl -s -H "Authorization: Bearer $BRAN" $U/api/items
curl -s -H "$H" -H "Authorization: Bearer $BRAN" -d '{"item":"LAMP_OIL_ID","amount":2}' $U/api/pack/give
curl -s -H "$H" -H "Authorization: Bearer $BRAN" -d '{"item":"LAMP_OIL_ID","amount":50}' $U/api/pack/spend   # 409
curl -s -H "$H" -H "Authorization: Bearer $BRAN" -d '{"recipient":"SERA_ID","body":"The gate is shut."}' $U/api/messages
```

Then the four statuses on `GET /api/messages/:id`: 200 with Sera's token, 403 with Bran's, 403 with Ivo's, 404 for an id that matches nothing.
