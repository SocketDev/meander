# API Documentation

This document describes the API.

## Endpoints

### GET /api/users

Returns a list of users.

**Parameters:**

- `limit` (optional): Maximum number of results
- `offset` (optional): Pagination offset

**Response:**

```json
{
  "users": [],
  "total": 0
}
```

## Authentication

All API requests require an API key header:

```
Authorization: Bearer YOUR_API_KEY
```

## Another Section

More content here.
