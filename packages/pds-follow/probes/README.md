# Throwaway probes used to verify the R4 findings

Not part of the deliverable; kept because they are the evidence.

- `raw-frames.mjs <host> <cursor|-> <seconds>` — dumps `subscribeRepos` frames
  straight off the wire (header + body, CBOR-decoded, no @atproto/sync). This is
  what produced the verbatim `#info`/`#commit`/`#sync`/`#identity`/`#account`
  and `FutureCursor` error-frame evidence.
- `bisect-cursor.mjs <host> <iso-time>` — binary-searches a PDS's seq space for
  the cursor whose first replayed event is just before a wall-clock time. Used
  to replay a narrow historical window instead of the whole 24h buffer.
- `find-recent.mjs` — scans `runs/dids_resolved.json` for repos whose newest
  calendar record falls inside the cursor replay window.
- `probe-ws.mjs <hosts...>` — which candidate hosts actually serve a live
  `subscribeRepos`.
- `reconnect-probe.mjs <host> <seconds>` — drives `@atproto/ws-client` directly
  to expose the reconnect/backoff lifecycle that `@atproto/sync`'s `Firehose`
  hides.
