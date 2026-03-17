# Article Tag APIs — Widget Integration Spec

Public, unauthenticated endpoints served through Fastly CDN (`cdn.divee.ai`). All endpoints require `projectId` as a query parameter.

**Base URL:** `https://cdn.divee.ai/functions/v1/articles`

---

## Endpoints

### 1. `GET /articles/tags` — Tags for a single article

Returns all tags assigned to a specific article.

**Query Parameters:**

| Param | Required | Default | Description |
|---|---|---|---|
| `projectId` | Yes | — | Project ID |
| `articleId` | Yes | — | Article `unique_id` |

**Response (200):**
```json
{
  "tags": [
    { "value": "Politics", "type": "category", "confidence": 0.97 },
    { "value": "Donald Trump", "type": "person", "confidence": 0.95 },
    { "value": "United States", "type": "place", "confidence": 0.91 }
  ]
}
```

**Cache:** 1 hour (`Cache-Control: public, max-age=3600, s-maxage=3600`)

---

### 2. `GET /articles/by-tag` — Newest articles by tag

Returns articles matching a specific tag, ordered by newest first.

**Query Parameters:**

| Param | Required | Default | Max | Description |
|---|---|---|---|---|
| `projectId` | Yes | — | — | Project ID |
| `tag` | Yes | — | — | Exact tag value (title-cased, e.g. `Donald Trump`) |
| `tagType` | No | — | — | Filter by type: `category`, `person`, or `place` |
| `limit` | No | 20 | 50 | Number of articles to return |
| `offset` | No | 0 | — | Pagination offset |

**Response (200):**
```json
{
  "articles": [
    {
      "unique_id": "abc123",
      "title": "Trump announces new trade policy",
      "url": "https://example.com/article/123",
      "image_url": "https://example.com/img/123.jpg",
      "created_at": "2026-03-15T10:30:00Z",
      "confidence": 0.95
    }
  ]
}
```

**Cache:** 10 minutes (`Cache-Control: public, max-age=600, s-maxage=600`)

---

### 3. `GET /articles/related` — Related articles by tag similarity

Returns articles related to a given article, scored by shared tag overlap with type weighting:
- **person** tags: 2.0× weight
- **place** tags: 1.5× weight
- **category** tags: 1.0× weight

**Query Parameters:**

| Param | Required | Default | Max | Description |
|---|---|---|---|---|
| `projectId` | Yes | — | — | Project ID |
| `articleId` | Yes | — | — | Article `unique_id` to find related articles for |
| `limit` | No | 5 | 20 | Number of related articles to return |

**Response (200):**
```json
{
  "articles": [
    {
      "unique_id": "def456",
      "title": "Senate debates trade deal implications",
      "url": "https://example.com/article/456",
      "image_url": "https://example.com/img/456.jpg",
      "created_at": "2026-03-14T08:00:00Z",
      "shared_tag_count": 3,
      "tag_score": 4.47
    }
  ]
}
```

**Cache:** 30 minutes (`Cache-Control: public, max-age=1800, s-maxage=1800`)

---

## Error Responses

**400 — Missing required parameter:**
```json
{ "error": "Missing required parameter: projectId" }
```

**400 — Invalid project:**
```json
{ "error": "Invalid projectId" }
```

**500 — Internal error:**
```json
{ "error": "Internal server error" }
```

---

## CORS

All responses include `Access-Control-Allow-Origin: *` (wildcard). Security is enforced by validating `projectId` exists in the database.

---

## Caching Details

| Endpoint | Browser TTL | CDN TTL | Surrogate-Key |
|---|---|---|---|
| `/articles/tags` | 1 hour | 1 hour | `articles-{projectId}` |
| `/articles/by-tag` | 10 min | 10 min | `articles-{projectId}` |
| `/articles/related` | 30 min | 30 min | `articles-{projectId}` |

All responses include:
- `Cache-Control: public, max-age={ttl}, s-maxage={ttl}`
- `Surrogate-Control: max-age={ttl}`
- `Surrogate-Key: articles-{projectId}`

Cache is soft-purged via Fastly when new tags are written by the `tag-articles` cron job.

---

## Widget Usage Examples

```javascript
// Fetch tags for the current article
const tagsResp = await fetch(
  `${cachedBaseUrl}/articles/tags?projectId=${projectId}&articleId=${articleId}`
);
const { tags } = await tagsResp.json();

// Fetch newest articles with the same category tag
const byTagResp = await fetch(
  `${cachedBaseUrl}/articles/by-tag?projectId=${projectId}&tag=${encodeURIComponent(tags[0].value)}&limit=10`
);
const { articles: taggedArticles } = await byTagResp.json();

// Fetch related articles for suggestion ranking
const relatedResp = await fetch(
  `${cachedBaseUrl}/articles/related?projectId=${projectId}&articleId=${articleId}&limit=5`
);
const { articles: relatedArticles } = await relatedResp.json();
```

---

## Tag Types Reference

| Type | Examples | Weight in `/related` scoring |
|---|---|---|
| `category` | Politics, Economy, Technology, AI, Sports | 1.0× |
| `person` | Donald Trump, Elon Musk, Apple, Nike | 2.0× |
| `place` | United States, France, European Union | 1.5× |

- Tags are title-cased and language-matched to the article (Hebrew articles get Hebrew tags, etc.)
- Max 5 tags per article
- Exact match on tag value (no fuzzy/partial matching)
