# S3-compatible storage for COGNIX[WS] backups

A COGNIX[WS] extension that keeps encrypted copies of your backups in an S3
bucket: Cloudflare R2, Backblaze B2, Wasabi, MinIO, AWS S3 or any storage that
speaks S3.

COGNIX[WS] encrypts and deduplicates every copy on your computer before it
reaches this extension (ADR-0368). The bucket holds only encrypted objects
named by their hash: the storage can lose a copy, and COGNIX[WS]'s checks will
find it, but it cannot read or change one.

## Set up

1. Create a bucket used only for these copies.
2. Create an API key that can read, write and list that bucket. If the key
   cannot delete, turn on **Never delete here**.
3. In COGNIX[WS], install this extension, open its settings and fill in:

| Setting | Cloudflare R2 | Backblaze B2 | AWS S3 |
|---|---|---|---|
| Storage address | `https://<account id>.r2.cloudflarestorage.com` | `https://s3.<region>.backblazeb2.com` | `https://s3.<region>.amazonaws.com` |
| Region | `auto` | the bucket's region, like `us-west-004` | the bucket's region |

4. In **Backups → Destinations → Add destination**, choose **S3-compatible storage**.

Plain `http://` is accepted only for this computer and your home network (a
NAS running MinIO, for example). Requests are signed; the key itself never
travels.

## How it works

The extension answers the subset of restic's REST protocol (version 2) that
COGNIX[WS] uses and keeps each repository in the bucket with restic's layout:
`<folder>/<repository>/{config,keys,index,snapshots,locks,data/xx}`.

- Every upload is signed with the object's SHA-256, which is its name, and the
  extension holds back the last piece of each upload until the hash matches,
  so no server keeps a body that is not its name.
- Ranges are always answered with 206, also from servers that ignore Range.
- Only a status code ever reaches COGNIX[WS]; the storage's own error text
  does not.
- The settings check uses the saved key only for the saved address and
  bucket; a new address or bucket needs the key typed again.
- A cancelled upload or listing stops at once and gives its connection back.
- The status names one place per configured bucket. Its id changes with the
  address, bucket or folder, so a destination never follows a settings change
  into another bucket.

## Test

```bash
node --test test/*.test.mjs
```

With an S3 server, the conformance kit from COGNIX[WS] runs too:

```bash
S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_BUCKET=backups \
S3_TEST_KEY=... S3_TEST_SECRET=... node --test test/*.test.mjs
```

It passes against SeaweedFS and `rclone serve s3`.

## License

Apache-2.0.
