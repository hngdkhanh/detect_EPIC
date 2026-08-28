# How to use Data API Query

Data API Query lets you run SQL queries against the GHN data warehouse over a simple HTTP API, using a personal API token. This page explains how to get access and how to call the API.

> If you don't have deep technical knowledge, we recommend reading and following **section 6 — How to use this document with AI agent** below.

> If you encounter the error **"Don't have permission for that data"** and you know the exact table you need to access, follow this document to request permission: <https://docs.google.com/document/d/1N3mXb1YqvZlErKw8TIjxBbn350qgSIi-6GIy3CPTKuI/edit?usp=sharing>. If you are not sure which table you need and only have an idea of the data you are looking for, contact the Data Team — we will help identify the appropriate table and grant you the required permissions.

## 1. Getting access — the flow

Account creation, tokens, and quotas are managed by the **Data team** in the Data Portal. Your token identifies _you_: every query runs in the warehouse as you, so data-access permissions and audit are per-person.

1. **Request an account.** Contact the Data team and provide:

    * For an **employee**: your **GHN Employee ID**.
    * For a **service / non-employee** (e.g. a chatbot or pipeline): a **name** of that service. The Data team generates an internal ID for it.

2. **The Data team creates the account** in the portal
3. **The Data team generates a token** and shares it with you securely. **The full token is shown only once** — store it safely. If lost, a new one must be generated (and the old one revoked).
4. **The Data team sets your quota** — a daily request limit (default 200). Ask for more if you need it.
5. **If you run out mid-day**, ask the Data team to **top up** your quota — this grants extra requests for the rest of today only (resets to your normal limit tomorrow) and can be done multiple times.

Tokens can be **revoked** by the Data team at any time. A revoked or expired token stops working within ~1 minute.

## 2. Quotas & limits

| Limit | Value | Notes |
| --- | --- | --- |
| Rate limit | 30 requests / second | Applies to **every** request — including `/next` polling, not just `POST /queries`. Exceeding it returns `429 rate_limited` — slow down and retry. (Only the daily quota is `POST /queries`-only.) |
| Daily quota | e.g. 200 / day (per account) | Set by the Data team. Counts accepted `POST /queries` requests (polling `/next` does not consume quota). Resets at 00:00 UTC. Exceeding it returns `429 quota_exceeded`. |
| Top-up | On request | Extra requests for _today only_; can be applied repeatedly. Your base limit is unchanged. |
| Max SQL size | 100 KB | Longer SQL is rejected with `400 bad_request` ("sql exceeds max length"). Shorten or split the query. |
| Batch size | Variable | Each `/next` returns one result chunk (one segment); the row count varies per call. There is no fixed batch size — keep calling `/next` until `hasMore` is `false`. |

**New account and getting** `429 quota_exceeded` **immediately?** An account with no quota configured yet (or with its quota disabled) also returns `429 quota_exceeded` — the message says "no quota configured for this user" or "quota disabled for this user". Ask the Data team to set up (or re-enable) your quota.

## 3. Calling the API (technical)

* [https://data-api-provider.ghn.vn/api/v1](https://data-api-provider.ghn.vn/api/v1)

### Base URL & authentication

Confirm the exact host for your environment with the Data team. All endpoints live under `/api/v1`. Every request must carry your token:

```
Authorization: Bearer dap_prod_xxxxxxxxxxxxxxxx
```

The token must be in the `Authorization` header — cookies and query-string tokens are not accepted.

### Endpoints

| Method & path | Purpose |
| --- | --- |
| `POST /api/v1/queries` | Submit a SQL query. Returns a `queryId` and `status: RUNNING` quickly (usually `rows: []`) — **it does not return data**. Fetch all rows from `/next`. |
| `GET /api/v1/queries/{id}/next` | Fetch the next batch. Repeat until `hasMore` is `false`. |
| `DELETE /api/v1/queries/{id}` | Cancel a running query (best effort). |

### Step 1 — Submit a query

**Request body:**

```json
{ "sql": "SELECT order_id, total FROM orders WHERE status = 'DELIVERED' LIMIT 100" }
```

> **Escape double quotes inside your SQL.** The `sql` value is a JSON string, so any double quote `"` inside the SQL (for example when quoting a catalog name like `"ghn-reporting"`) must be escaped as `\"` in the request body. Otherwise the JSON is invalid and the query **cannot be parsed or run**.
>
> For example, this SQL:
>
> ```sql
> SELECT salary_date, warehouse_id, warehouse_name, employee_id, driver_name AS employee_name FROM "ghn-reporting".testing.epic_result WHERE salary_date >= date_add('day', -1, current_date) ORDER BY salary_date
> ```
>
> must be sent in the request body as:
>
> ```json
> { "sql": "SELECT salary_date, warehouse_id, warehouse_name, employee_id, driver_name AS employee_name FROM \"ghn-reporting\".testing.epic_result WHERE salary_date >= date_add('day', -1, current_date) ORDER BY salary_date" }
> ```

**Example (curl):**

```shell
curl -X POST https://DATA_API_HOST/api/v1/queries \
  -H "Authorization: Bearer dap_prod_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT order_id, total FROM orders WHERE status = '\''DELIVERED'\'' LIMIT 100"}'
```

**Response (200 OK):** the submit returns immediately with the `queryId`, `status`, and `schema`. `rows` is usually empty — the query is just starting. Fetch the data with `/next`.

```json
{
  "queryId": "q_e31d624a",
  "status": "RUNNING",
  "schema": [
    { "name": "order_id", "type": "BIGINT" },
    { "name": "total",    "type": "DECIMAL" }
  ],
  "rows": [],
  "hasMore": true,
  "totalRowCount": 0
}
```

The submit response also carries the header `X-Quota-Remaining` — how many requests you have left in today's quota. Use it to self-throttle instead of waiting for a `429`. Every query response also carries an `X-Query-Id` header.

### Step 2 — Fetch the next batches

Use the `queryId` from the submit response. Keep calling `/next` until `hasMore` is `false`.

```shell
curl https://DATA_API_HOST/api/v1/queries/q_e31d624a/next \
  -H "Authorization: Bearer dap_prod_xxxxxxxxxxxxxxxx"
```

**Final batch** has `"hasMore": false` and includes `stats`:

```json
{
  "queryId": "q_e31d624a",
  "status": "FINISHED",
  "schema": [],
  "rows": [ [10004210, "99.00"] ],
  "hasMore": false,
  "totalRowCount": 1,
  "stats": { "rowsReturned": 41280, "bytesScanned": 18234112, "elapsedMs": 3850 }
}
```

The loop signal is `hasMore`, not `status`. Keep calling `/next` while `hasMore` is `true`. A few rules:

* **Still computing?** When `rows` is empty (`[]`) and `hasMore` is `true`, the query hasn't produced data yet — **wait ~10 seconds before calling `/next` again**; don't poll in a tight loop. When data is ready, `/next` returns it (one result chunk per call; size varies).
* **Got `503 pod_busy` (or a transient error)?** The server was momentarily busy — **wait briefly (e.g. 100ms→200ms→400ms) and retry the *same* `/next`**. This is safe: a failed `/next` does **not** advance the cursor, so it resumes from the same position — you won't skip rows or get duplicates. Only a *successful* `/next` moves on to the next batch.
* **One `/next` at a time** per query — overlapping calls for the same `queryId` return `409 conflict`.
* **Don't pause too long** between calls (more than a few minutes), or the query may expire (`410 query_expired`).

### Step 3 — Cancel (optional)

```shell
curl -X DELETE https://DATA_API_HOST/api/v1/queries/q_e31d624a \
  -H "Authorization: Bearer dap_prod_xxxxxxxxxxxxxxxx"
```

Returns `204 No Content` if cancellation was requested.

### Complete example (Python)

```python
import requests
import time

BASE = "https://DATA_API_HOST"
TOKEN = "dap_prod_xxxxxxxxxxxxxxxx"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1) submit — returns a queryId, not data
r = requests.post(f"{BASE}/api/v1/queries",
                  headers=HEADERS,
                  json={"sql": "SELECT order_id, total FROM orders LIMIT 1000"})
r.raise_for_status()
batch = r.json()

query_id = batch["queryId"]
columns = [c["name"] for c in batch.get("schema", [])]
rows = list(batch["rows"])

# 2) drain — poll /next until hasMore is false
while batch["hasMore"]:
    resp = requests.get(f"{BASE}/api/v1/queries/{query_id}/next", headers=HEADERS)

    # 503 pod_busy / 409 conflict: server busy — retry the SAME /next.
    # Safe: a failed /next does not advance the cursor (no skip, no duplicate).
    if resp.status_code in (503, 409):
        time.sleep(0.5)
        continue

    resp.raise_for_status()
    batch = resp.json()
    rows.extend(batch["rows"])  # no-op when rows is []

    # rows empty + hasMore: query still computing — wait before the next poll
    if batch["hasMore"] and not batch["rows"]:
        time.sleep(10)

print("columns:", columns)
print("total rows:", len(rows))
```

## 4. Response fields

| Field | Meaning |
| --- | --- |
| `queryId` | Use it for `/next` and `DELETE`. |
| `status` | `QUEUED` / `RUNNING` / `FINISHED` / `FAILED` / `CANCELLED`. Informational only. |
| `schema` | Column names and types. Always included on the first batch; some backends may repeat it on later batches, so read it once from the first batch and ignore any repeats. |
| `rows` | Array of rows; each row is an array of values in column order. Variable size — one result chunk (segment) per call. Empty `[]` with `hasMore: true` means the query is still computing — wait ~10s and call `/next` again. |
| `hasMore` | `true` → call `/next` again. `false` → done. |
| `totalRowCount` | Number of rows in **this** batch (the same as the length of `rows` in this response). For the running total across all batches, read `stats.rowsReturned` on the final batch. |
| `stats` | Only on the final batch: `rowsReturned`, `bytesScanned`, `elapsedMs`. |

**Response headers:**

| Header | Meaning |
| --- | --- |
| `X-Quota-Remaining` | On `POST /queries` responses: requests left in today's quota. Use it to self-throttle. |
| `X-Query-Id` | On every query response: the `queryId` of the request (handy in logs). |

## 5. Errors & how to handle them

All errors share this shape:

```json
{ "error": { "code": "...", "message": "...", "queryId": "..." } }
```

| HTTP | Code | Meaning & what to do |
| --- | --- | --- |
| 401 | `unauthorized` | Missing / invalid / revoked / expired token. Check the header; ask the Data team for a new token if needed. |
| 403 | `forbidden` | You don't have permission for that data (or the query isn't yours). Contact the Data team to request access. |
| 403 | `read_only` | The statement is not a read query. Only `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `VALUES` are allowed; `INSERT`, `UPDATE`, `DELETE`, `MERGE`, and DDL are rejected. Use a read-only query. |
| 404 | `not_found` | `/next` on an unknown or already-finished query. Submit again. |
| 409 | `conflict` | Another `/next` for this query is still running. Poll **one at a time** — wait for the previous response, then retry. |
| 410 | `query_expired` | You paused too long between `/next` calls. Resubmit the query. |
| 410 | `cancelled` | The query was canceled (by your `DELETE`, or killed server-side). It is terminal — resubmit to run again. Further `/next` calls return `404`. |
| 429 | `rate_limited` | More than 30 req/sec across your requests (`POST /queries` and `/next`). Slow down and retry after a short delay. |
| 429 | `quota_exceeded` | Daily limit reached — or your account has no quota configured / quota disabled yet (check the message). Wait for the daily reset, ask the Data team to top up, or ask them to set up your quota. |
| 400 | `query_error` / `bad_request` | SQL is invalid (syntax, type, missing column or table), the body is malformed, or the SQL exceeds 100 KB. Fix the SQL. |
| 503 | `pod_busy` | Server is busy. Retry the **same** `/next` after a brief delay (e.g. 100ms, 200ms, 400ms backoff, up to 3 tries). Retrying is safe — a failed `/next` does not advance the cursor, so it resumes from the same position (no rows skipped or duplicated). |
| 502 / 504 | `trino_error` | Warehouse-side issue — a Trino internal error, cluster overloaded, connection/transport failure, or the query ran longer than the gateway allows and timed out (returned as `504`). Retry later; contact the Data team if it persists. |
| 499 | `cancelled` | You closed the connection while a long-poll `/next` was still waiting (the request was cancelled client-side). No server action is needed — the query keeps running; call `/next` again if you still want the results. |

## 6. How to use this document with AI agent

### With claude code MCP

```
# connect claude with confluence
claude mcp add atlassian npx mcp-remote https://mcp.atlassian.com/v1/mcp

# prompt
"Read the confluence page id: 1590198952 then..."
```

### With readme file

If your AI agent can't reach Confluence (no MCP server configured), give it the same instructions as a local file instead:

1. **Export this page to a markdown file** in your project, e.g. `docs/data-api.md` (in Confluence: **… → Export → Export to Word/PDF**, or simply copy the page content into the file).
2. **Put your token in an environment variable** (e.g. `DATA_API_TOKEN`) — never paste the token into the prompt, the file, or your code.
3. **Reference the file in your prompt:**

```
# prompt
"Read docs/data-api.md to learn how the Data API works, then write a
Python script that runs <your SQL> against it. Read the API token from
the DATA_API_TOKEN environment variable."
```

Keep the local file in sync — when this Confluence page changes, re-export it so your agent doesn't work from outdated instructions.

## 7. Tips & FAQ

* **Keep your token secret.** Don't commit it to code or share it. Store it in a secret manager / environment variable.
* **Escape double quotes in SQL.** If your SQL contains double quotes (e.g. quoted catalog/identifier names like `"ghn-reporting"`), escape each one as `\"` inside the JSON `sql` string — otherwise the request body is invalid JSON and can't be parsed or run. See **Step 1 — Submit a query**.
* **POST returns a `queryId`, not data.** All rows come from `/next` — always loop on `/next` until `hasMore: false`.
* **When `rows` is `[]` and `hasMore` is `true`, wait ~10s** before the next `/next` — the query is still computing.
* **Always drain the query** (loop until `hasMore: false`) or cancel it — don't abandon it mid-stream.
* **Retrying `/next` is safe.** If a `/next` fails (e.g. `503 pod_busy` or a transient error), just call the **same** `/next` again — a failed call doesn't advance the cursor, so it resumes from where it left off (no rows skipped or duplicated). Only a *successful* `/next` moves on to the next batch.
* **One query at a time per loop** — submit, then iterate that `queryId` to completion (one `/next` at a time, or you'll get `409 conflict`).
* **Need more quota or hit a permission error?** Contact the Data team — that's the channel for account creation, tokens, quota, top-ups, and data access.
