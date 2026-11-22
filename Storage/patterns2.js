/* Subsystem-level designs: dedup/compression, erasure coding + self-healing, multi-tenant QoS. */
window.PATTERNS.push(
{
  id: "dedup-pipeline",
  name: "Inline Dedup & Compression Pipeline",
  tag: "Dedup",
  tagline: "Shrink the footprint on the write path without stalling writes or exploding read amplification.",
  scale: [["Dedup ratio","2-10x (workload)"],["Chunk","4-64 KB avg"],["Hash","SHA-256"],["Index","RAM Bloom + SSD"],["Write overhead","< 20% latency"]],
  requirements: [
    "Inline (before data hits durable media): chunk, fingerprint, dedup, compress, then store",
    "Add < ~20% to write latency and keep line-rate throughput per node",
    "Bounded read amplification: reads must not seek across hundreds of containers",
    "Safe distributed reference counting; deletes must never free a chunk that is still referenced",
    "Compression ratio and dedup ratio must be observable per tenant/volume"
  ],
  layers: [
    {title:"Ingest", nodes:[{n:"Write front-end",d:"Buffers stream, NVRAM/WAL ack"},{n:"Chunker",d:"CDC (Rabin / Gear / FastCDC) with min/avg/max bounds"},{n:"Hasher",d:"SHA-256 per chunk (SHA-NI / offload)"}]},
    {title:"Fingerprint index", nodes:[{n:"Bloom filter (RAM)",d:"Definitely-new vs maybe-seen; ~10 bits/chunk, ~1% FP"},{n:"Hot index cache (RAM)",d:"LRU of recent fingerprints + locality-preserved prefetch"},{n:"Full index (SSD, LSM / sharded)",d:"fingerprint -> (container, offset, len, refcount)"}]},
    {title:"Compress & pack", nodes:[{n:"Compressor",d:"LZ4 (fast) / ZSTD (ratio), per-chunk, skip incompressible"},{n:"Container writer",d:"Packs unique chunks into 4-32 MB append-only containers"},{n:"Recipe / file manifest",d:"Ordered list of fingerprints per object/volume"}]},
    {title:"Background", nodes:[{n:"Refcount GC",d:"Mark-and-sweep / epoch-based"},{n:"Container compaction",d:"Rewrite sparse containers; re-cluster for locality"},{n:"Re-compress / cold recompaction",d:"ZSTD high level on aged data"}]}
  ],
  flows: {
    "Write": [
      "Data lands in a WAL / NVRAM buffer and is acked (durability point), then the pipeline runs asynchronously in segments",
      "CDC splits the stream with a rolling hash; boundary where <code>hash &amp; mask == 0</code>, bounded by min/max chunk size",
      "SHA-256 each chunk. Probe Bloom filter: 'no' means definitely unique, skip any disk lookup",
      "'Maybe': check hot cache, then SSD index. Hit means dedup (just increment refcount / add recipe entry); miss means unique",
      "Compress unique chunks (skip if ratio < ~1.05), append to the open container, insert into the index, write the recipe"
    ],
    "Read": [
      "Load the recipe (list of fingerprints) for the requested range",
      "Group chunk fetches by container to batch I/O; prefetch the rest of a container on first touch (stream-informed locality)",
      "Verify checksum, decompress, reassemble; cache whole containers/blocks, not single chunks"
    ],
    "Delete": [
      "Delete removes the recipe/manifest in a metadata txn and records a pending 'decrement set' (or relies on mark-sweep)",
      "GC (below) decides which chunks are unreferenced; containers with low live ratio are compacted",
      "Space is reclaimed only after a grace period so in-flight writers cannot resurrect a freed chunk"
    ]
  },
  deepDives: [
    {t:"Fixed-size vs content-defined chunking", b:"<b>Fixed-size</b> is cheap and aligns with block devices, but one inserted byte shifts every later chunk and dedup collapses. <b>CDC</b> (Rabin fingerprint over a ~48 B sliding window) cuts where the rolling hash matches a mask, so boundaries follow content: an edit changes only 1-2 chunks. Use min (e.g. 2 KB), avg (8-16 KB), max (64 KB) to avoid pathological tiny/huge chunks; FastCDC/Gear hashing is 2-5x faster than Rabin. Fixed-size is fine for VM/block volumes with aligned writes; CDC wins for files, backups and shifted data."},
    {t:"Fingerprint index at scale", b:"1 PB unique at 8 KB avg = ~125B chunks; at ~40 B per entry that is ~5 TB, far too large for RAM. Layers: (1) a RAM Bloom filter (~10 bits/entry, 1% FP) answers 'new chunk' with zero I/O, which is the common case for the first write of data; (2) a locality-preserved cache: when one fingerprint hits in a container, prefetch that container's fingerprint list because neighbours in a stream are likely to follow (the 'disk bottleneck' technique); (3) an SSD-resident index partitioned by fingerprint prefix (consistent hashing across nodes, so dedup is global per shard owner). Sparse indexing (sample 1/N fingerprints per segment) trades a little dedup for a much smaller index."},
    {t:"Avoiding read amplification", b:"Dedup scatters a logical stream across many containers (fragmentation). Controls: container-level locality (pack chunks in stream order), rewrite 'fragmented' duplicates (don't dedup against old sparse containers; rewrite the chunk into the new container), container prefetch, and keeping the newest backup the most contiguous. Track a fragmentation metric (containers touched per MB) and drive the rewrite policy from it."},
    {t:"Compression", b:"Compress after dedup (fewer bytes to compress). Adaptive: sample or entropy-test the chunk; store raw if incompressible. LZ4 for hot paths (>1 GB/s/core), ZSTD level 3 default, level 10+ for cold re-compaction. Compression is per chunk so random reads stay cheap; the container header records the codec."},
    {t:"Distributed GC and reference counting", b:"Exact distributed refcounts are fragile (lost increments/decrements leak or, worse, free live data). Robust patterns: <b>(a)</b> refcount in the index updated in the same txn as the recipe commit; decrements applied via an idempotent, versioned delete log (each op has a unique id so retries do not double-decrement). <b>(b)</b> Periodic <b>mark-and-sweep</b> as the source of truth: enumerate live recipes into a Bloom/perfect-hash 'live set', sweep containers, and free chunks not in it. <b>(c)</b> <b>Epoch / grace period</b>: a chunk is only reclaimed if it was unreferenced in two consecutive epochs and is older than the max in-flight write duration; writers that dedup against a chunk 'pin' it for the epoch. <b>(d)</b> Never delete in the same step as unlink; mark dead, wait, then compact the container."},
    {t:"Hash collisions and integrity", b:"SHA-256 collision probability is negligible; still keep a per-chunk CRC32C and verify on read. Optionally byte-compare on a dedup hit for paranoid tiers. Encrypted tenants: convergent encryption (key = hash of content) allows dedup but leaks equality; use per-tenant keys and dedup within a tenant only if confirmation attacks matter."}
  ],
  failures: [
    ["Index node lost","Rebuild index from container footers (each container stores its chunk fingerprints); Bloom filters rebuilt from index"],
    ["Bloom filter false positive","Falls through to SSD index; costs one lookup, never correctness"],
    ["Crash mid-pipeline","WAL replay; containers are append-only and sealed with a footer + checksum; unsealed tails are discarded"],
    ["Lost/duplicated decrement","Idempotent op ids plus periodic mark-and-sweep reconciliation fixes drift"],
    ["Dedup against a chunk being freed","Epoch pinning + grace period; sweep only frees chunks unreferenced across two epochs"]
  ],
  tradeoffs: [
    ["Chunking","CDC (avg 8-16 KB)","Handles shifted offsets; more CPU and metadata than fixed blocks"],
    ["Index","Bloom + locality cache + SSD","Avoids a disk lookup per chunk; index memory stays bounded"],
    ["Inline vs post-process","Inline after WAL ack","Saves write bandwidth/space immediately; ack does not wait on dedup"],
    ["GC","Refcount + mark-sweep + epochs","Fast reclamation with a correctness backstop"],
    ["Compression","LZ4 hot / ZSTD cold","Throughput vs ratio by data temperature"]
  ],
  cheat: "Ack from WAL, then CDC -> SHA-256 -> Bloom filter (no disk for unique chunks) -> locality-cached index -> compress -> pack into containers with a recipe. Fight fragmentation with container locality and rewrites. Distributed GC: idempotent refcount log + mark-sweep + epoch grace so a live chunk is never freed."
},
{
  id: "ec-selfheal",
  name: "Erasure Coding & Self-Healing Subsystem",
  tag: "EC",
  tagline: "Higher durability than 3x replication at ~1.3-1.5x overhead, with cheap, throttled, automatic repair.",
  scale: [["Overhead","1.3-1.5x"],["Scheme","RS 8+3 / 10+4"],["Fault domains","node / rack / AZ"],["Scrub cycle","2-4 weeks"],["Repair target","< 24 h"]],
  requirements: [
    "Durability >= 11 nines at < 1.5x overhead (vs 3x for replication)",
    "Survive m simultaneous node/disk losses per stripe and a full rack or AZ loss",
    "Minimise recovery network traffic and time-at-risk",
    "Handle small and partial-stripe writes without crippling write amplification",
    "Detect and repair silent corruption proactively"
  ],
  layers: [
    {title:"Encode path", nodes:[{n:"EC encoder (gateway / writer node)",d:"RS via ISA-L/SIMD (GB/s/core), builds k data + m parity shards"},{n:"Stripe writer",d:"Full-stripe appends to open stripe groups; write buffer for small IO"}]},
    {title:"Placement", nodes:[{n:"Placement service",d:"Cluster map; one shard per node, bounded per rack/AZ"},{n:"Stripe metadata",d:"stripe -> (shard locations, scheme, version, checksums)"}]},
    {title:"Shard nodes", nodes:[{n:"Shard store",d:"Immutable shards + per-block CRC32C/SHA-256 footer"},{n:"Local integrity service",d:"Scrubber, SMART/latency health, disk fail-fast"}]},
    {title:"Self-healing", nodes:[{n:"Failure detector",d:"Heartbeats + disk health; delay before declaring 'permanent'"},{n:"Repair scheduler",d:"Priority by remaining redundancy; rate-limited"},{n:"Rebuild workers",d:"Read k (or LRC local group), decode, write to new domain"}]}
  ],
  flows: {
    "Write (full stripe)": [
      "Buffer incoming data into k data blocks (e.g. 8 x 1 MB stripe unit)",
      "Encode m parity blocks; write k+m shards in parallel to distinct fault domains",
      "Commit stripe metadata (shard map + checksums) atomically; ack",
      "Small writes go to a replicated or log-structured buffer first, then are aggregated into full stripes"
    ],
    "Read": [
      "Normal: read only the data shards needed (no decode); verify per-block checksum",
      "Degraded: fetch any k surviving shards (including parity) and decode; hedge slow shards by requesting k+1",
      "Corrupt block found: serve via degraded read and enqueue a repair for that shard"
    ],
    "Repair": [
      "Failure detector waits a grace period (e.g. 10-15 min for node, immediate for disk) to avoid churn on transient faults",
      "Scheduler enumerates affected stripes, orders by fewest surviving shards (stripes at k+1 survivors first)",
      "Rebuild worker reads k shards, decodes only the lost shards, writes them to a new node in a legal fault domain",
      "Update metadata; verify checksum; throttle with bandwidth budgets per node/rack"
    ]
  },
  deepDives: [
    {t:"Choosing k + m", b:"Overhead = (k+m)/k. RS(8+3) = 1.375x tolerating 3 losses; RS(10+4) = 1.4x tolerating 4; 3x replication tolerates 2 at 3.0x. Wider stripes lower overhead but raise: repair read traffic (k shards read to rebuild 1), stripe width vs failure-domain count (need >= k+m domains), and tail latency of reads that touch many shards. Rule of thumb: k+m <= number of racks (or AZs x per-AZ limit). Durability model: MTTDL ~ MTBF^(m+1) / (n! style terms x repair time^m); durability is dominated by repair time, so fast repair beats an extra parity."},
    {t:"Reducing repair traffic: LRC and regenerating codes", b:"Plain RS reads k shards to rebuild one. <b>LRC (Locally Repairable Codes)</b>, e.g. (12,2,2): split data into local groups of 6 each with a local parity; a single loss (the common case) reads only 6 shards, ~2x less traffic, at the same 1.33x overhead as RS(12,4) but slightly weaker worst-case tolerance (it survives any 3 losses and most 4-loss patterns). <b>Clay / regenerating codes</b> reduce repair bandwidth further. <b>Piggybacking</b> and rack-local repair (rebuild within a rack when a local parity exists) reduce cross-rack traffic, which is the scarcest resource."},
    {t:"Fault-domain aware placement", b:"Constrain: at most 1 shard per node, at most p shards per rack where p <= m, and for AZ survival at most m shards per AZ (so RS(10+4) over 3 AZs needs <= 4 per AZ, which uses the whole parity budget; use a wider m or LRC for AZ + extra node failure). Placement is stable (consistent hashing / CRUSH-like) so a node loss moves little data."},
    {t:"The small-write problem", b:"Updating one data block in a stripe means new parity = old parity xor f(old data, new data): <b>read-modify-write</b> costs reading 1 data + m parity blocks and writing 1 data + m parity (write amplification of m+1 and extra latency), plus a consistency hazard (the 'write hole' if a crash lands between shard writes). Options: <b>(1) Log-structured full-stripe appends</b>: buffer small writes in a replicated journal (NVMe, 3x) and flush as full stripes; updates and deletes create new stripes and old ones are reclaimed by GC/compaction (best for object stores, append workloads). <b>(2) Parity logging</b>: keep parity deltas in a log and merge lazily. <b>(3) Hybrid</b>: replicate hot/small data (3x), EC the cold/large data. <b>(4) Atomic stripe versioning</b> (write new shards under a new version, commit via metadata) to close the write hole."},
    {t:"Background scrubbing and bit rot", b:"Every block carries CRC32C (cheap, per 4-64 KB) and every shard/stripe a stronger SHA-256 in metadata. <b>Light scrub</b>: validate metadata vs files. <b>Deep scrub</b>: read all data, verify checksums, cycle every 2-4 weeks; on mismatch, treat the shard as lost and rebuild from the other shards (verify the rebuilt shard against the expected stripe checksum). Scrub reads are low priority and use the same throttling engine as repair. Verify on read as the first line of defense; use end-to-end checksums computed at the client to catch corruption in memory/network."},
    {t:"Throttling rebuild bandwidth", b:"Repair is a race: slow repair raises loss risk, fast repair hurts foreground latency. Use dynamic budgets: a floor (always make progress), a ceiling (cap % of disk and NIC), and elevated priority as a stripe approaches the loss threshold (e.g. 1 parity left means unthrottled). Schedule work to spread across many source/destination nodes (declustered repair) so a rebuild runs at aggregate cluster speed, not one disk's speed."}
  ],
  failures: [
    ["Single disk fails","Declustered parallel rebuild across the cluster; data readable in degraded mode meanwhile"],
    ["Rack loss","Placement guarantees <= p shards per rack; all stripes still have >= k shards"],
    ["Second failure during repair","Priority bump to affected stripes; scheduler re-sorts by remaining redundancy"],
    ["Crash during stripe write (write hole)","Versioned stripes + metadata commit; uncommitted shards are orphans for GC"],
    ["Silent corruption","Checksum mismatch on read/scrub then degraded read and rebuild of that shard"],
    ["Correlated failure (bad batch / firmware)","Diversify hardware batches across a stripe; alarm on failure-rate spikes"]
  ],
  tradeoffs: [
    ["Scheme","RS 8+3 / 10+4 (LRC for repair)","1.4x overhead; more shards raise repair and tail-latency cost"],
    ["Small writes","Log-structured full-stripe appends","Removes RMW amplification; needs GC of stale stripes"],
    ["Hot data","3x replicate, EC when cold","Fast, cheap small IO now; capacity savings later"],
    ["Repair","Prioritised, declustered, throttled","Short time-at-risk without wrecking foreground IO"],
    ["Integrity","CRC32C per block + SHA-256 per stripe","Cheap fast detection plus strong verification of rebuilds"]
  ],
  cheat: "Pick k+m to fit fault domains (RS 8+3 / 10+4, LRC to cut repair reads). Full-stripe log-structured writes avoid read-modify-write and the write hole; replicate hot small data. Self-healing = failure detector with grace, repair prioritised by remaining redundancy, declustered and bandwidth-throttled; deep scrub with CRC32C/SHA-256 catches bit rot."
},
{
  id: "qos-engine",
  name: "Multi-Tenant QoS & Throttling Engine",
  tag: "QoS",
  tagline: "Stop noisy neighbours from exhausting IOPS, bandwidth or metadata locks, while background work yields to foreground traffic.",
  scale: [["Tenants","100k+"],["Decision cost","< 1 us (local)"],["Limits","IOPS / MB/s / ops"],["Scheduler","WFQ / DRR / mClock"],["Burst","token credit"]],
  requirements: [
    "Per-tenant (and per-bucket/volume/prefix) limits on IOPS, bandwidth and metadata ops",
    "Guarantee reservations (min), enforce limits (max), share spare capacity by weight",
    "Foreground latency protected from compaction, EC rebuild, scrub, GC",
    "Enforcement at multiple layers: API gateway, metadata shards, storage nodes and disks",
    "Scalable: no central bottleneck on the request path; limits survive gateway scale-out"
  ],
  layers: [
    {title:"Admission (gateway)", nodes:[{n:"Request classifier",d:"Tenant, op type, size, priority class"},{n:"Token buckets",d:"Per tenant: IOPS bucket + bytes bucket (+ metadata-ops bucket)"},{n:"Cost model",d:"cost = 1 op + size/unit; reads vs writes vs list weighted"}]},
    {title:"Distributed limit state", nodes:[{n:"Local limiter with leases",d:"Each gateway holds a slice of the tenant's rate"},{n:"Rate coordinator",d:"Rebalances slices by observed demand (periodic, off hot path)"},{n:"Overload shedding",d:"429/503 SlowDown + Retry-After; client-side backoff"}]},
    {title:"Storage node scheduler", nodes:[{n:"Per-disk queues",d:"One queue per (tenant, class)"},{n:"WFQ / mClock scheduler",d:"Reservation + limit + weight tags per request"},{n:"Priority classes",d:"Foreground > replication > compaction/GC > rebuild > scrub"}]},
    {title:"Metadata protection", nodes:[{n:"Per-shard / per-prefix limiter",d:"Caps ops per partition; fair share of Raft group capacity"},{n:"Lock/txn budgets",d:"Cap concurrent txns and lock hold per tenant; hot-key detection"}]}
  ],
  flows: {
    "Admission": [
      "Gateway classifies the request and computes its cost (e.g. 1 IOPS + bytes)",
      "Takes tokens from the tenant's IOPS and bandwidth buckets; if empty, queue briefly (bounded) or reject with 429 + Retry-After",
      "Burst: bucket capacity > refill rate lets short spikes through; credits accumulate while idle",
      "Request is tagged with tenant/class and forwarded; metadata ops pass a per-shard limiter"
    ],
    "Disk scheduling": [
      "Storage node places the IO into the tenant's queue for its priority class",
      "Scheduler assigns reservation/limit/proportional tags (mClock) or virtual finish times (WFQ/DRR)",
      "Dispatches the smallest eligible tag; background classes get a guaranteed trickle and the remainder of idle capacity",
      "Queue depth to the device is bounded (e.g. NVMe QD) so latency is controlled in software, not by the device queue"
    ],
    "Rebalance": [
      "Rate coordinator samples per-gateway usage every ~100-500 ms",
      "Re-leases token slices proportional to demand, keeping the sum <= the tenant limit",
      "Fail-open/closed policy on coordinator loss: continue with the last lease with decay, so a control outage does not become a data outage"
    ]
  },
  deepDives: [
    {t:"Token bucket vs leaky bucket", b:"<b>Token bucket</b>: refills at rate r up to capacity B; a request consumes tokens, so bursts up to B are allowed and the long-run average is r. Ideal for S3/EBS-style 'burst credits'. <b>Leaky bucket</b> (as a queue): requests drain at a constant rate, smoothing output and giving shaping rather than just policing. Use token buckets for admission (policing) and a leaky-bucket-style smoothed dispatch for the device. Implementation: store <code>(tokens, last_refill_ts)</code> and lazily refill with CAS; no timers per tenant. Use two buckets (IOPS and bytes) so tiny IO and huge IO both get fair treatment."},
    {t:"Scaling limits across many gateways", b:"A single central counter is a bottleneck. Options: (1) <b>static split</b> (limit/N per gateway, wrong under skew); (2) <b>leases</b>: a coordinator hands each gateway a token slice and rebalances by demand (what this design uses); (3) <b>approximate global counters</b> via gossip/CRDT counters or Redis with Lua scripts and local pre-fetch of token batches. Accept slight over-admission (bounded by lease size) in exchange for sub-microsecond local decisions."},
    {t:"Weighted fair queuing and mClock", b:"WFQ gives each tenant a share proportional to weight w: virtual finish time F = max(V, F_prev) + cost / w. DRR is an O(1) approximation using per-queue deficit counters. <b>mClock</b> adds three per-tenant knobs: <b>reservation</b> (min IOPS guaranteed), <b>limit</b> (hard cap), <b>weight</b> (share of the remainder). Tags: R, L and P; requests with R tag due are served first (reservation phase), then lowest P tag among queues under their limit (weight phase). This is what lets 'gold' tenants get guaranteed IOPS while spare capacity is split fairly."},
    {t:"Foreground vs background", b:"Compaction, GC, EC rebuild and scrub are themselves tenants of the disk with a class. Policy: foreground always preempts at dispatch; background gets a minimum share (never starved, or durability suffers) and the idle remainder; share rises as risk rises (e.g. a stripe with 1 parity left gets promoted to foreground priority). Rate limiters on background work are adaptive: shrink when foreground p99 exceeds its SLO, grow when idle (AIMD / PID control on observed latency)."},
    {t:"Metadata and lock protection", b:"Noisy neighbours also exhaust metadata: a tenant hammering one prefix hammers one Raft group. Protect with per-prefix/per-shard token buckets, caps on concurrent transactions and lock hold times, hot-range splitting plus 503 SlowDown, request coalescing (singleflight for identical reads), and per-tenant LIST page-size and scan-cost budgets (a LIST costs more tokens than a HEAD)."},
    {t:"Fairness, isolation and noisy-neighbour detection", b:"Isolation layers: logical (limits) and physical (dedicated queues/shards/cells for premium tenants, cell-based architecture to bound blast radius). Detect: per-tenant metrics (rate, queue wait, throttle %), top-N heavy hitters via count-min sketch, and automatic demotion of tenants repeatedly hitting limits. Make throttling visible: <code>429 SlowDown</code>, <code>Retry-After</code>, and rate-limit headers; clients use exponential backoff with jitter to avoid retry storms."}
  ],
  failures: [
    ["Rate coordinator down","Gateways continue on last lease with decay; fail-open for reservations, fail-closed for abusive tenants"],
    ["Thundering herd after throttle","Jittered backoff, token-bucket smoothing, bounded queue so latency does not collapse"],
    ["Hot partition from one tenant","Per-shard limiter + split; tenant isolated to its own queue"],
    ["Background starvation","Guaranteed minimum share and risk-based promotion (rebuild at critical redundancy)"],
    ["Misconfigured limit","Limits staged with dry-run (shadow mode) metrics before enforcement"]
  ],
  tradeoffs: [
    ["Limiter","Token bucket with leases","Allows bursts, O(1), scalable; slight over-admission between rebalances"],
    ["Scheduler","mClock (reservation, limit, weight)","Guarantees plus fair sharing; more tuning than plain WFQ"],
    ["Overload","Reject early (429) with backoff","Protects tail latency; clients must retry well"],
    ["Background work","Weighted share + AIMD on latency","Foreground SLO preserved, durability tasks still progress"],
    ["Isolation","Logical limits + cells for premium","Cost vs blast-radius control"]
  ],
  cheat: "Token buckets (IOPS + bytes, cost-weighted) at the gateway with leased slices for scale; mClock/WFQ per disk with reservation/limit/weight; strict class priority with a guaranteed trickle for compaction, rebuild and scrub; per-shard limiters for metadata; reject early with 429 + Retry-After."
}
);
