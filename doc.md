Always show details

# -_- coding: utf-8 -_-

# Create downloadable documentation files (Markdown + HTML) in /mnt/data

from datetime import datetime, timezone, timedelta

date_str = "2025-09-06"
title = "UNAS import – Részletes dokumentáció (jelen állapot)"
subtitle = f"Dátum: {date_str}"

# Use plain triple-quoted strings (no f-strings) to avoid brace issues.

content_md = """

# UNAS import – Részletes dokumentáció (jelen állapot)

_Dátum: 2025-09-06_

> Megjegyzés: Ez a dokumentum a jelenlegi források és egyeztetések alapján készült. Célja, hogy egyben összefoglalja az **architektúrát, végpontokat, jogosultságot, üzemeltetést, ismert korlátokat** és a **scheduler-hozzáférést**.  
> Preferencia: _„mezők értékeit ne alakítsd át”_ – az alkalmazás ezt tiszteletben tartja (kivételek: ár/készlet számolt mezők).

## Tartalom

1. Rövid áttekintés
2. Architektúra
3. Autentikáció és jogosultság
4. Frontend komponensek
5. Backend modulok
6. REST API
7. Adatmodell (Firestore)
8. Környezeti változók
9. Ismert korlátok
10. Telepítés / frissítés
11. Hibaelhárítás
12. Végpont minták
13. Változások ezen a napon
14. TODO / következő lépések

---

## 1) Rövid áttekintés

Az alkalmazás célja külső feed(ek)ből termékadatok **letöltése → parzolása → transzformálása → UNAS-ba feltöltése**, a futások naplózása mellett.  
Admin felület: **Vue** • Backend: **Node/Express** • Adattár: **Firestore** • Scheduler: API hívások.

**Fő pipeline:**

1. `downloadFile` – feed letöltés (XLSX/CSV/XML)
2. `parseData` – rekordlista egységesítése
3. `transformData` – árképzés, kerekítés, készlet normalizálás  
   – _nem módosít más, bemásolt mezőértéket_
4. `uploadToUnas` – párosítás + UNAS módosítás (dry-run támogatott)
5. Napló mentése: `runs` kollekció

---

## 2) Architektúra

[Frontend (Vue)]
├─ Login (Firebase Auth)
├─ ShopSelector / ProcessTable / LogsViewer / RunButton / ExchangeRates / ProcessForm
└─ API hívások (Axios, Bearer ID token)
│
▼
[Backend (Express)]
├─ Auth middleware:
│ • requireFirebaseUser (ID token)
│ • allowCronOrUser (X-CRON-SECRET vagy user)
├─ Modulok:
│ • downloadFile.js
│ • parseData.js
│ • transformData.js
│ • uploadToUnas.js
│ • productDbIndex.js
│ • index.js (route-ok)
└─ Firestore (Admin SDK) – shops / processes / runs

[Scheduler]
└─ API hívások (X-CRON-SECRET vagy OIDC)

[UNAS]
└─ ProductDB + setProduct API

Always show details

**Kulcselv:** a frontend **read-only** módon, valós időben _olvashat_ Firestore-ból (pl. `runs`), **minden írás** a backend Admin SDK-ján keresztül történik.

---

## 3) Autentikáció és jogosultság

### 3.1 Frontend

- **Firebase Auth** (tipikusan Google provider).
- Router guard + App.vue UI-gate: kijelentkezve a dashboard **nem** látható (`v-if="ready && user"`).
- Axios interceptor: minden API-híváshoz **Authorization: Bearer <ID token>**.

### 3.2 Backend

- `requireFirebaseUser` – ellenőrzi a Firebase ID tokent.
- `allowCronOrUser(requireFirebaseUser)` – ha `X-CRON-SECRET` egyezik, **scheduler** átmehet token nélkül; különben user auth kell.

### 3.3 Scheduler

- **Egyszerű:** `X-CRON-SECRET: <random hosszú secret>` header
- **Felhős:** OIDC (pl. Cloud Scheduler JWT) – opcionális, erősített megoldás.

### 3.4 Firestore Security Rules (kliens)

- Olvasás: **csak bejelentkezve** (`request.auth != null`)
- Írás: **tiltott** (mindent a backend végez)

Mintaszabályok:

// firestore.rules
rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
function isAuthed() { return request.auth != null; }

Always show details
match /shops/{doc} { allow read: if isAuthed(); allow write: if false; }
match /processes/{doc} { allow read: if isAuthed(); allow write: if false; }
match /runs/{doc} { allow read: if isAuthed(); allow write: if false; }

}
}

Always show details

---

## 4) Frontend komponensek (jelen állapot)

- **App.vue** – Auth állapot figyelése; védett UI csak `user && ready` esetén renderel; opcionális mini Login/Logout UI.
- **ShopSelector.vue** – `shops` valós idejű listázása (Firestore read-only).
- **ProcessTable.vue** – `processes` valós idejű listázása.
- **LogsViewer.vue** – `runs` listázás; válthat Firestore streamre (`VITE_USE_FS_CLIENT_READ=true`) vagy API `/api/logs`-ra.
- **RunButton.vue** – manuális futtatás (`POST /api/run`).
- **ExchangeRates.vue** – árfolyam UI (`GET /api/rates`).
- **ProcessForm.vue** – process-konfig mentése (`POST /api/config`).

**Fontos:** a megjelenített mezőértékeket **nem alakítjuk át**, csak a dátumokat formázzuk megjelenítéshez, ha szükséges.

---

## 5) Backend modulok és szerepük

- **`downloadFile.js`** – HTTP GET `arraybuffer`; content-type + méret log; `Buffer` vissza.
- **`parseData.js`** – XLSX/CSV/XML egységesítése rekordtömbbé.
- **`transformData.js`**
  - `fieldMapping` szerinti **másolás** (kivétel: `price`, `stock` – számolt mezők).
  - Árképzés képlettel vagy alapképlettel: `{basePrice}`, `{discount}`, `{priceMargin}`, `{vat}`.
  - Nettó↔bruttó logika; devizakonverzió (ha aktív); kerekítés (pl. 5-ös).
  - Készlet normalizálás + `orderable`.
  - Kimenet: `price_net`, `price_gross`, kompatibilitás: `price = price_gross`.
- **`uploadToUnas.js`**
  - UNAS token; ProductDB letöltés (CSV); indexelés.
  - Rekordonként `ensureNetGross` → diff → `setProduct` (nem dry-run esetén).
  - Statisztika: `modified`, `skippedNoKey`, `skippedNotFound`, `failed`.
- **`productDbIndex.js`** – kulcs szerinti index építése (kanonizálható).
- **`index.js`** – Express route-ok, naplózás, Firestore írás.

---

## 6) REST API (védett – user vagy scheduler)

> A `/api/health` kivételével minden végpont **allowCronOrUser(requireFirebaseUser)** védelmet kap.

- **GET** `/api/health` → `{ ok: true, time: <ISO> }` – nyitott.
- **GET** `/api/config` → `shops`, `processes` betöltése.
- **POST** `/api/config` → process létrehozás/frissítés (`referenceAt` mentéskor).
- **DELETE** `/api/config/:processId` → process törlése.
- **GET** `/api/unas/fields?shopId=...&processId?=...` → ProductDB fejléc (+ `paramsXml` figyelembe véve).
- **GET** `/api/feed/headers?url=...` → feed első sor kulcsai.
- **POST** `/api/run` → futtatás (DL/parse/transform/upload + napló).
- **GET** `/api/logs` → utolsó (max 100) futás.
- **POST** `/api/logs/prune` → régi naplók törlése (alap 30 nap).
- **GET** `/api/rates` → árfolyam + timestamp.

**Scheduler példa (curl):**

```bash
curl -X POST https://<host>/api/run \
  -H "X-CRON-SECRET: $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"processId":"..."}'
```

## 7) Adatmodell – Firestore kollekciók

Példamezők – nem módosítjuk az értékeket megjelenítéskor.

### 7.1 shops

shopId (doc id szerepben is)

name

unasApiKey (backend használja; kliensre ne küldjük)

### 7.2 processes

processId (doc id)

displayName

shopId

feedUrl

fieldMapping (pl. "SKU" -> "sku")

pricingFormula, vat, discount, priceMargin, rounding

convertCurrency, targetCurrency

referenceAt (mentéskori horgony)

frequency (pl. "30m", "3h", "1d")

### 7.3 runs

id (doc id)

processId, processName, shopId, shopName

startedAt, finishedAt, durationMs, stages (downloadMs, parseMs, transformMs, uploadMs)

counts (input, output, modified, skippedNoKey, skippedNotFound, failed)

items[] – részletes változás-lista (before/after, diff)

error (ha volt)

## 8) Környezeti változók

Backend:

CRON_SECRET – scheduler „szervizbejárat” header

UNAS_API_URL (alap: https://api.unas.eu/shop)

UNAS_TIMEOUT_MS, UNAS_DOWNLOAD_TIMEOUT_MS

UNAS_PRODUCTDB_MAX_RETRIES, UNAS_PRODUCTDB_BACKOFF_MS

UNAS_INDEX_TTL_HOURS

Firebase Admin cred (pl. GOOGLE_APPLICATION_CREDENTIALS vagy beágyazott SA JSON)

Frontend (Vite):

VITE_FIREBASE_API_KEY

VITE_FIREBASE_AUTH_DOMAIN

VITE_FIREBASE_PROJECT_ID

VITE_FIREBASE_APP_ID

VITE_FIREBASE_MESSAGING_SENDER_ID

VITE_FIREBASE_STORAGE_BUCKET

VITE_USE_FS_CLIENT_READ (opcionális, pl. true)

## 9) Ismert korlátok és teendők

UNAS indexelés: egy helyen a kód unasIndex.get(unasKey)-et hívhat a mezőnévvel – a helyes kulcs a feed-rekord értéke (pl. rec[feedKey] kanonizálva).
Teendő: audit és javítás, hogy a feed értékével keressen az UNAS indexben.

Devizakonverzió: külső utilra támaszkodik; hiba esetén marad az eredeti deviza.

Endpoint-védelem: győződj meg róla, hogy a /api/* route-ok előtt mindig fut az allowCronOrUser.

Rules: ne maradjon Firestore „teszt mód”.

## 10) Telepítés / frissítés

Frontend

npm i firebase

.env – Vite változók

App.vue UI-gate + router guard

(Opcionális) Firestore read-only stream

Backend

Middleware-ek: requireFirebaseUser, allowCronOrUser

CRON_SECRET beállítás; scheduler header küldése

UNAS és Firebase env-ek beállítása

Firestore

Rules deploy (read-only kliens)

Kollekciók: shops, processes, runs

## 11) Hibaelhárítás (gyorstár)

„Kijelentkezve is látom a dashboardot.”

App.vue: v-if="ready && user" megvan?

Router guard: meta.requiresAuth + beforeEach működik?

Backend: /api/config 200 token nélkül? –> middleware hiányzik

Firestore Rules: request.auth != null?

„Scheduler 401/403-at kap.”

Küld X-CRON-SECRET-et? Egyezik az env-vel?

OIDC esetén JWT verifikáció log?

„UNAS SKU nem található.”

feedKey vs unasKey párosítás (kulcsérték kanonizálása)

ProductDB index TTL / cache invalidálás

## 12) Végpont minták

### 12.1 /api/run (dry-run)
Always show details
{
  "shopId": "my-shop",
  "processId": "proc-123",
  "dryRun": true
}

### 12.2 /api/config (mentés)
Always show details
{
  "processId": "proc-123",
  "displayName": "Példa import",
  "shopId": "my-shop",
  "feedUrl": "https://example.com/feed.xlsx",
  "fieldMapping": {
    "SKU": "sku",
    "Bruttó Ár": "price",
    "Raktárkészlet": "stock"
  },
  "pricingFormula": "{basePrice} * (1 + {priceMargin})",
  "priceMargin": 0.10,
  "vat": 0.27,
  "rounding": 5,
  "frequency": "1d"
}
## 13) Változások ezen a napon (2025-09-06)

Frontend: Auth gate + (opcionális) Firestore read-only stream beépítése.

Backend: Middleware-minta a teljes /api védelmére + scheduler „szervizbejárat”.

Dokumentáció: egységesített architektúra, API, jogosultság, ismert korlátok.

## 14) TODO / következő lépések

UNAS indexelés kulcskezelésének javítása.

(Opcionális) Cloud Scheduler OIDC JWT-verifikáció.

Swagger/OpenAPI specifikáció az /api/* végpontokhoz.

Rich diff-nézet a LogsViewerben (mezőnkénti változás).

E2E tesztek importfolyamatra (mock feed + dry-run + statisztika).

Vége
```
