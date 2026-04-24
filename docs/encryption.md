# Encryption at rest

All user content is encrypted before storage using AES-256-GCM via
the Web Crypto API. This doc covers what gets encrypted, how the
key is derived, and the binary format on disk.

## What is and isn't encrypted

| Data                                                             | Encryption                                     |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Walkthrough HTML files (`index.html`, `part-*.html`, `documents.html`) | AES-256-GCM with a unique IV per file         |
| Comment `body` and `author` fields                               | AES-256-GCM with a unique IV per comment      |
| Comment metadata (`id`, `file`, line numbers, `resolved`, `created_at`) | **Not encrypted** — stored as plaintext   |
| The shared CSS file (`meander.css`)                              | **Not encrypted** — served directly by browsers |
| The build manifest (`manifest.json`)                             | **Not encrypted** — contains only counts + paths |

Metadata stays plaintext so the Val Town SQLite database can index
and sort it without round-tripping every row through decryption.
Body + author are what you actually want private; those travel
encrypted.

## Key derivation

The encryption key is derived from `WALKTHROUGH_PASS` using
PBKDF2-SHA256 with 600,000 iterations and a fixed salt
(`meander-walkthrough-v1`).

- **One credential**: the same password protects both HTTP basic
  auth (access) and at-rest encryption (data).
- **Deterministic**: the same password always produces the same
  key, so the `meander publish` CLI and the deployed val stay in
  sync without shipping the key separately.
- **Rotation**: changing `WALKTHROUGH_PASS` means (a) re-publishing
  all walkthrough HTML (the old ciphertext can no longer be
  decrypted) and (b) existing comments become unreadable and
  should be cleared.

## Binary format

Encrypted values are stored as base64-encoded bytes laid out as:

```
[1 byte: version 0x01]
[12 bytes: random IV]
[N bytes: AES-GCM ciphertext]
[16 bytes: GCM auth tag]
```

The version byte lets future releases migrate the algorithm
(different cipher, different key length) without breaking existing
deployments — a decryptor sees an unknown version byte and can
either refuse or fall back.

## Why this design

- **AES-GCM, not CBC**: GCM combines encryption with authentication
  in a single pass. A tampered ciphertext fails to decrypt (the
  auth tag won't match), so we never risk showing corrupted prose
  as if it were real.
- **Unique IV per value**: reusing an IV under GCM leaks the
  plaintext. `crypto.randomBytes(12)` makes collisions negligible.
- **Password-derived key**: the deployer doesn't juggle a separate
  key file — the same password protects access + data. Trade-off:
  rotating the password requires re-publishing, which is the price
  for eliminating a second credential.
