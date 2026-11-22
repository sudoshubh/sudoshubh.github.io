/* Storage-domain system design patterns. Data-driven: app.js renders each entry.
   Add a new pattern by appending an object to PATTERNS (same shape). */
window.PATTERNS = [
{
  id: "object-store",
  name: "S3-Compatible Object Store",
  tag: "Object",
  tagline: "Billions of immutable objects, KB to TB, with strong read-after-write consistency.",
  scale: [["Objects","100B+"],["Logical size","~100 PB"],["Durability","11 nines"],["Overhead","~1.4x (EC)"],["Peak","1M req/s"]],
  requirements: [
    "PUT/GET/HEAD/DELETE/LIST, range reads, multipart upload up to 5 TB, versioning, lifecycle, pre-signed URLs",
    "Strong read-after-write and list-after-write consistency",
    "11 nines durability, 99.99% availability, p99 first-byte < 100 ms for small GETs",
    "Cost: ~1.4x raw-to-usable via erasure coding, not 3x replication"
  ],
  layers: [
    {title:"Edge", nodes:[{n:"LB / Anycast",d:"L4/L7, TLS"},{n:"API Gateway fleet",d:"SigV4, throttling, checksums, SSE, EC encoder (stateless)"}]},
    {title:"Control plane", nodes:[{n:"Metadata Service",d:"Range-sharded Raft KV with ACID txns"},{n:"Placement Service",d:"Cluster map, failure domains, volume allocator"},{n:"IAM / Bucket config",d:"Policies cached at gateway"}]},
    {title:"Data plane", nodes:[{n:"Storage nodes",d:"12-60 HDDs, NVMe index, no RAID"},{n:"Volumes",d:"32-64 GB append-only logs; small objects packed Haystack-style"},{n:"EC stripes",d:"RS(10+4) or LRC across AZs"}]},
    {title:"Background", nodes:[{n:"GC / Scavenger",d:"Tombstones + orphan sweep"},{n:"Repair / Scrubber",d:"Prioritised by fewest surviving shards"},{n:"Compactor / Lifecycle / CRR",d:"Reclaim volumes, expire, replicate"}]}
  ],
  flows: {
    "PUT": [
      "Gateway authenticates (SigV4), authorises, checks quota",
      "Stream body, compute MD5/SHA-256 + CRC32C, cut into 8-64 MB chunks",
      "RS-encode each chunk; write k+m shards in parallel to distinct nodes across AZs; fsync",
      "Write manifest, then ONE metadata transaction inserts the Object row (new version)",
      "Return 200 + ETag only after the metadata commit. Failure before commit leaves invisible orphans for GC"
    ],
    "GET": [
      "Look up Object row on the shard leader (cache validated by version)",
      "Resolve chunks, fetch k of k+m shards in parallel (hedged: ask k+1, use fastest k)",
      "Verify per-shard CRC, decode, stream; ranges touch only affected chunks",
      "Missing/corrupt shard: degraded read from parity and enqueue repair"
    ],
    "Multipart": [
      "Initiate: MPU row with unique upload_id",
      "UploadPart(n): parts stored like normal objects but unreferenced; Part row written; re-upload overwrites the row",
      "Complete: one txn validates ETags/order/min size, concatenates part manifests (no data copy), inserts Object row, enqueues unused parts for GC",
      "Idempotent: a retry sees state DONE. Abort vs Complete race is decided by the txn"
    ]
  },
  deepDives: [
    {t:"Metadata vs data separation", b:"Metadata is small (~500 B/object, ~50 TB total), hot and transactional. Data is huge and streamed. Keys are <code>bucket_id | key | (MAX - version_ts)</code> so newest sorts first and LIST is a range scan. Range (not hash) partitioning keeps ordering; hot prefixes are handled by load-based splitting and 503 SlowDown."},
    {t:"Small vs large objects", b:"<b>Tiny (<=4 KB)</b>: inline in the metadata row. <b>Small (4 KB-1 MB)</b>: packed into volume logs with 3x replication and an in-memory index, so a read is one seek and no inodes are used; group-commit batches writes. <b>Large</b>: chunked and erasure-coded. Sealed small-object volumes can be EC-converted later."},
    {t:"Consistency invariant", b:"Metadata is committed last and atomically, after all data is durable. A GET can never observe an object whose bytes are not durable."},
    {t:"Garbage collection", b:"Three layers: (1) transactional GC tombstones written in the same txn as the delete/overwrite/Complete; (2) an orphan scavenger that deletes chunks older than a safety window T (e.g. 24 h) that no manifest, open MPU or pending GC record references; (3) volume compaction when live ratio < ~50%, using a metadata CAS per moved needle."},
    {t:"Durability", b:"End-to-end CRC32C, light and deep scrubbing, prioritised repair, LRC to cut repair traffic. Shards placed so any single-AZ loss leaves >= k shards."}
  ],
  failures: [
    ["Gateway dies mid-PUT","Client retries; overwrite is atomic; orphans GC'd after window"],
    ["Storage node dies","Degraded reads from parity; repair scheduler rebuilds; writes route elsewhere"],
    ["Metadata leader dies","Raft re-elects in seconds; committed entries are replicated"],
    ["AZ outage","Metadata keeps quorum (2 of 3); EC keeps >= k shards"],
    ["Bit rot","CRC mismatch on read/scrub, reconstruct from parity"]
  ],
  tradeoffs: [
    ["Metadata store","Range-sharded Raft KV + ACID txns","Ordered LIST and atomic commit need ranges and transactions"],
    ["Small objects","Packed volumes + 3x replication","Avoid inode exhaustion and EC IOPS amplification"],
    ["Large objects","RS / LRC erasure coding","1.4x vs 3x cost; LRC mitigates repair cost"],
    ["Multipart commit","Concatenate manifests","O(parts) metadata, zero data movement"],
    ["Cross-region","Async via change log","Latency and availability at the cost of RPO > 0"]
  ],
  cheat: "Separate metadata from data. Commit metadata last and atomically so read-after-write holds. Pack small objects, erasure-code large ones. Multipart parts are invisible until one txn concatenates manifests. GC = tombstones + time-windowed scavenger + compaction."
},
{
  id: "block-store",
  name: "Distributed Block Storage (EBS-like)",
  tag: "Block",
  tagline: "Low-latency, durable virtual disks with snapshots, attached to VMs over the network.",
  scale: [["Write p99","< 1 ms"],["Block","4 KiB"],["Replicas","3 (ISR)"],["Snapshots","CoW, incremental"],["Durability","99.999%+"]],
  requirements: [
    "Block read/write (4 KiB aligned) with strict ordering and flush semantics per volume",
    "Sub-millisecond p99 writes, provisioned IOPS/throughput with QoS isolation",
    "Crash-consistent snapshots, restore, clone, online resize",
    "Survive node/rack/AZ failures without data loss; re-replicate without starving foreground I/O"
  ],
  layers: [
    {title:"Client", nodes:[{n:"VM / hypervisor",d:"virtio-blk / NVMe-oF"},{n:"Block client agent",d:"Caches partition map, routes IO, handles retries and epochs"}]},
    {title:"Control plane", nodes:[{n:"Coordinator",d:"Raft-backed: volumes, partitions, placement, epochs"},{n:"Snapshot service",d:"Cross-partition consistent cut, upload to object store"},{n:"QoS / billing",d:"Token buckets per volume"}]},
    {title:"Data plane", nodes:[{n:"Primary replica",d:"Sequences writes, fans out in parallel"},{n:"Backup replicas x2",d:"Different racks / AZs"},{n:"On-node engine",d:"WAL on NVMe/PMem + redirect-on-write extents + index"}]},
    {title:"Durable tier", nodes:[{n:"Object store",d:"Snapshot chunks, lazy-hydrate restore"}]}
  ],
  flows: {
    "Write": [
      "Client sends write to the partition primary with (volume, offset, epoch, seq)",
      "Primary validates epoch, assigns sequence number, appends to its WAL and fans out in parallel to backups",
      "Ack to client when all in-sync replicas (ISR) have durably written the WAL",
      "Background: WAL entries are applied to extents with redirect-on-write; index updated atomically"
    ],
    "Read": [
      "Served from the primary (or any in-sync replica for read scaling) using the extent index",
      "Block cache / write-back cache on NVMe for hot data",
      "Unwritten blocks of a clone/restore are lazily hydrated from the snapshot in object storage"
    ],
    "Snapshot": [
      "Coordinator issues a barrier with a snapshot epoch to all partitions of the volume",
      "Each partition freezes its index (cheap; extents are immutable under redirect-on-write)",
      "Changed extents since the last snapshot are uploaded incrementally to the object store",
      "Delete = refcount decrement on shared extents; unreferenced chunks are GC'd"
    ]
  },
  deepDives: [
    {t:"Replication: primary-backup with epoch fencing", b:"Parallel fan-out from the primary gives one network round-trip. The ISR set plus a monotonically increasing epoch stored in the Coordinator fences a stale primary after a partition, preventing split-brain."},
    {t:"Redirect-on-write extents", b:"New data goes to fresh extents and the index is swapped, so old extents stay immutable and snapshots are just an index reference. This also avoids read-modify-write on HDD/SSD and enables cheap snapshots."},
    {t:"Not starving foreground I/O", b:"Re-replication is rate-limited, prioritised by fewest surviving replicas, and scheduled into idle IO budget per disk. Gray failures (slow disks) are detected by latency outliers and demoted from ISR."},
    {t:"Data integrity", b:"Per-block CRC, background scrubbing across replicas, and end-to-end checksums verified at the client agent."}
  ],
  failures: [
    ["Primary fails","Coordinator bumps epoch, promotes an ISR member; client agent refreshes map and retries"],
    ["Backup slow/fails","Removed from ISR; writes continue with remaining replicas; re-replicate in background"],
    ["Network partition","Epoch fencing: old primary's writes rejected by replicas"],
    ["Node restart","Replay WAL, rebuild index from checkpoint, catch up from the primary's log"]
  ],
  tradeoffs: [
    ["Replication","Primary-backup, 3 copies","Lowest latency; EC adds read-modify-write on small blocks"],
    ["Update strategy","Redirect-on-write","Cheap snapshots, sequential writes, but needs extent GC/defrag"],
    ["Snapshot target","Object store, incremental","Cheap, durable, region-replicable; restore needs lazy hydration"],
    ["Consistency","Linearisable per volume","Matches disk semantics; cross-volume ordering is not needed"]
  ],
  cheat: "Primary-backup with ISR and epoch fencing for ~1 ms writes; WAL on fast media; redirect-on-write extents make snapshots an index copy; throttled prioritised repair protects foreground latency.",
  doc: "distributed-block-storage-engine.md"
},
{
  id: "dfs",
  name: "Distributed File System (GFS / HDFS)",
  tag: "File",
  tagline: "Huge files, sequential throughput, one namespace server and thousands of chunk servers.",
  scale: [["Files","100M+"],["Chunk","64-256 MB"],["Replicas","3 (or EC 6+3)"],["Cluster","10k nodes, EB"],["Workload","Batch / analytics"]],
  requirements: [
    "Hierarchical namespace (POSIX-ish): create, rename, delete, list directories",
    "High aggregate throughput for large sequential reads and appends (MapReduce, Spark)",
    "Tolerate constant commodity-hardware failure",
    "Namespace operations are strongly consistent; data is append-oriented"
  ],
  layers: [
    {title:"Clients", nodes:[{n:"FS client library",d:"Caches chunk locations; talks to master only for metadata"}]},
    {title:"Namespace tier", nodes:[{n:"Active NameNode / Master",d:"Entire namespace + file-to-block map in RAM"},{n:"Standby + Journal quorum",d:"Edit log in JournalNodes / Raft; fast failover"},{n:"Federation",d:"Multiple namespaces/volumes to scale metadata"}]},
    {title:"Data tier", nodes:[{n:"DataNodes / ChunkServers",d:"Store blocks as local files with checksums"},{n:"Rack-aware placement",d:"Replica 1 local, 2-3 on a different rack"}]},
    {title:"Maintenance", nodes:[{n:"Block reports + heartbeats",d:"Master rebuilds location map; detects under-replication"},{n:"Balancer / EC converter",d:"Even out disks, convert cold data to EC"}]}
  ],
  flows: {
    "Write": [
      "Client asks master to create file / allocate a block; master returns a pipeline of 3 DataNodes (rack-aware)",
      "Client streams packets to DN1, which forwards to DN2, then DN3 (chain pipeline), each verifying CRC",
      "Acks flow back up the pipeline; on completion the client asks master to close the block/file",
      "Master persists the edit to the journal quorum before acknowledging namespace changes"
    ],
    "Read": [
      "Client asks master for block locations (sorted by network distance)",
      "Reads directly from the nearest DataNode; verifies checksum; falls back to another replica",
      "Short-circuit local reads if the client is co-located with the data"
    ],
    "Recovery": [
      "DataNode misses heartbeats -> declared dead; master computes under-replicated blocks",
      "Prioritise blocks with fewest replicas; instruct surviving DNs to copy",
      "Lease recovery finalises half-written files from crashed writers"
    ]
  },
  deepDives: [
    {t:"Metadata in memory", b:"~150 B per file/block means 100M files is tens of GB of heap, fine, but billions of small files is the classic failure. Mitigations: federation, container formats (SequenceFile/Parquet), or moving metadata to a sharded KV (like Colossus / Ozone)."},
    {t:"Single master and HA", b:"Edit log + periodic fsimage checkpoint. Standby tails the journal for hot failover; fencing prevents two active masters. Writes to namespace are serialised, reads can go to standby (observer) for scale."},
    {t:"Rack-aware placement", b:"One replica on the writer's node, second on another rack, third on the same rack as the second. Survives rack loss while limiting cross-rack bandwidth to one hop."},
    {t:"Append, leases and consistency", b:"Single-writer leases per file; appends go through the pipeline. Readers see a prefix up to the last hflush/hsync."}
  ],
  failures: [
    ["NameNode crash","Standby promotes after fencing; replays remaining journal"],
    ["DataNode/rack loss","Re-replication from survivors, prioritised by risk"],
    ["Writer crash mid-block","Lease expiry triggers block recovery to the minimum common length"],
    ["Corrupt replica","Client/scan detects bad CRC, reports; master replaces from a good copy"]
  ],
  tradeoffs: [
    ["Metadata","Single in-memory master","Simple, fast, strongly consistent; scale limit = small-files problem"],
    ["Block size","64-256 MB","Low metadata, high throughput; wasteful for small files"],
    ["Redundancy","3x hot, EC cold","Hot data needs locality and fast reads; cold data wants 1.5x"],
    ["Semantics","Write-once / append","Avoids distributed locking and complex consistency"]
  ],
  cheat: "Master holds namespace in RAM, data flows client-to-DataNode directly. Rack-aware 3x replication via pipeline. Journal quorum + standby for HA. Small files and master heap are the scaling cliff; federation or sharded metadata is the answer."
},
{
  id: "kv-lsm",
  name: "Distributed KV Store (Dynamo / LSM)",
  tag: "KV",
  tagline: "Always-on partitioned key-value store with tunable consistency on LSM-tree storage engines.",
  scale: [["Keys","Trillions"],["Latency","p99 < 10 ms"],["Replication","N=3"],["Quorum","R+W>N"],["Availability","99.999%"]],
  requirements: [
    "get/put/delete by key; optional range scan within a partition",
    "Horizontal scale with automatic rebalancing; no single point of failure",
    "Tunable consistency (eventual to strong) per request",
    "High write throughput and predictable tail latency"
  ],
  layers: [
    {title:"Client / Coordinator", nodes:[{n:"Smart client or any node as coordinator",d:"Hashes key, routes to replica set"}]},
    {title:"Cluster membership", nodes:[{n:"Consistent hash ring + vnodes",d:"Even load, cheap rebalancing"},{n:"Gossip + failure detector",d:"Phi-accrual; no central master"}]},
    {title:"Replica node", nodes:[{n:"Commit log (WAL)",d:"Sequential durable append"},{n:"Memtable",d:"Sorted in-memory structure"},{n:"SSTables + Bloom filters",d:"Immutable sorted files, tiered/leveled compaction"}]},
    {title:"Repair", nodes:[{n:"Hinted handoff",d:"Buffer writes for down replicas"},{n:"Read repair + Merkle anti-entropy",d:"Converge diverged replicas"}]}
  ],
  flows: {
    "Write": [
      "Coordinator hashes key to N replicas on the ring (preference list, spread over racks/AZs)",
      "Sends write to all N; waits for W acks. Replicas append to commit log, update memtable",
      "Memtable flushes to an immutable SSTable; compaction merges SSTables in the background",
      "If a replica is down, a hint is stored and replayed when it returns (sloppy quorum optional)"
    ],
    "Read": [
      "Coordinator queries R replicas (one full read + digests from others)",
      "Each replica checks memtable, then SSTables newest-first, skipping via Bloom filters and index",
      "Resolve conflicts by timestamp (LWW) or vector clocks / CRDTs; trigger read repair on mismatch"
    ],
    "Compaction": [
      "Size-tiered: good write throughput, higher space and read amplification",
      "Leveled: low read amplification and space, more write amplification",
      "Tombstones kept until gc_grace to avoid resurrecting deletes; repair must complete within it"
    ]
  },
  deepDives: [
    {t:"Quorum math", b:"R + W > N gives read-your-writes on a healthy cluster. N=3, W=2, R=2 is the common default. W=1/R=1 maximises availability and speed; W=N maximises durability. Strict linearisability needs Paxos/Raft per key (lightweight transactions) rather than quorum alone."},
    {t:"LSM trade-off triangle", b:"Write amplification vs read amplification vs space amplification. Bloom filters, block cache, partitioned indexes, and compaction strategy choose a point on the triangle. SSDs favour leveled; write-heavy time series favour time-window compaction."},
    {t:"Partitioning", b:"Consistent hashing with 128-256 vnodes per node. Adding a node steals small ranges from many nodes. Hot keys are mitigated by key salting or caching; range scans work within a partition key."},
    {t:"Alternative: Raft-per-shard (Spanner / CockroachDB / TiKV)", b:"Range sharding + Raft per range gives linearisable reads/writes and transactions at the cost of leader hot spots and cross-region latency."}
  ],
  failures: [
    ["Replica down","Hinted handoff and read repair; node rejoins and streams missed data"],
    ["Network partition","AP mode serves both sides with conflict resolution; CP mode refuses minority side"],
    ["Divergent replicas","Merkle-tree anti-entropy repair on a schedule"],
    ["Disk loss","Replace node; stream ranges from replicas (bootstrap/rebuild)"]
  ],
  tradeoffs: [
    ["Consistency","Tunable quorums","Per-request control of latency vs consistency"],
    ["Topology","Leaderless ring","No SPOF, high write availability; conflicts need resolution"],
    ["Engine","LSM tree","Sequential writes, great ingest; compaction and tail-latency tuning needed"],
    ["Conflict resolution","LWW vs vector clocks/CRDT","LWW is simple but loses concurrent updates"]
  ],
  cheat: "Consistent-hash ring with vnodes, N replicas, tunable R/W quorums, gossip membership. Writes go WAL -> memtable -> SSTable; reads use Bloom filters. Hinted handoff, read repair and Merkle anti-entropy keep replicas converged."
},
{
  id: "sync-dedup",
  name: "File Sync & Dedup Backup (Dropbox-style)",
  tag: "Sync",
  tagline: "Content-addressed chunk store with a versioned namespace, delta sync and global deduplication.",
  scale: [["Users","500M"],["Chunk","~4 MB (CDC)"],["Dedup","30-60% savings"],["Sync lag","seconds"],["Model","Block-level"]],
  requirements: [
    "Sync files across devices with low latency and bandwidth, including large files with small edits",
    "Versioning, restore, sharing, conflict handling",
    "Storage efficiency via deduplication across files and users",
    "Offline edits and eventual convergence"
  ],
  layers: [
    {title:"Client", nodes:[{n:"Desktop/mobile sync agent",d:"FS watcher, chunker (CDC), local SQLite state"},{n:"Chunk hasher",d:"SHA-256 per chunk"}]},
    {title:"Edge services", nodes:[{n:"Metadata / Sync service",d:"Namespace, file-to-chunk lists, per-account journal"},{n:"Block service",d:"Upload/download chunks, dedup check"},{n:"Notification service",d:"Long-poll / WebSocket 'something changed'"}]},
    {title:"Storage", nodes:[{n:"Metadata DB",d:"Sharded SQL/KV by namespace; strongly consistent per account"},{n:"Content-addressed chunk store",d:"Key = hash; EC object store underneath; refcounted"},{n:"Cold tier",d:"Infrequently read chunks to cheaper EC"}]}
  ],
  flows: {
    "Upload": [
      "Agent detects change, splits file with content-defined chunking (rolling hash) so insertions don't shift all chunks",
      "Hashes each chunk and sends the list to the Sync service; server replies which chunks are missing (dedup)",
      "Agent uploads only missing chunks to the Block service (parallel, resumable)",
      "Commit: server atomically writes a new file version = ordered chunk hash list, appends to the account journal"
    ],
    "Download": [
      "Notification wakes other devices; they pull journal entries since their cursor",
      "Compute which chunks they lack locally, download only those, reassemble the file"
    ],
    "Conflict": [
      "Commit carries the base version; server rejects if base != head (compare-and-swap)",
      "Loser is saved as a 'conflicted copy' preserving both edits; no silent overwrite"
    ]
  },
  deepDives: [
    {t:"Content-defined chunking", b:"Fixed-size blocks break dedup when bytes are inserted. A rolling hash (Rabin/Gear/FastCDC) cuts at content-based boundaries, so an edit changes only 1-2 chunks. Typical 1-8 MB with min/max bounds."},
    {t:"Global dedup and security", b:"Cross-user dedup saves space but leaks existence of a chunk (confirmation-of-file attack). Mitigate with proof-of-possession, per-tenant convergent-encryption keys, or limiting dedup to within an organisation."},
    {t:"Refcounting and GC", b:"Each chunk has a refcount from file versions. Version expiry decrements; chunks at zero are tombstoned and deleted after a grace period. Races with in-flight uploads are handled by upload sessions pinning chunks."},
    {t:"Metadata consistency", b:"Per-account (namespace) strong consistency via a sharded SQL DB; the journal gives each device a monotonic cursor, making sync an ordered log replay."}
  ],
  failures: [
    ["Upload interrupted","Chunk-level resume; only missing chunks re-sent"],
    ["Concurrent edits","CAS on base version, conflicted-copy creation"],
    ["Chunk store loss","Underlying EC object store repairs; refcount audit validates metadata vs store"],
    ["Notification lost","Periodic poll fallback using the journal cursor"]
  ],
  tradeoffs: [
    ["Chunking","Content-defined","Better dedup and delta sync; more CPU than fixed blocks"],
    ["Dedup scope","Per-org vs global","Security/privacy vs max savings"],
    ["Metadata store","Sharded SQL by account","Transactions and ordering per account; cross-account shares need care"],
    ["Sync model","Journal + cursor","Simple, resumable, offline-friendly"]
  ],
  cheat: "Client chunks with CDC, hashes, asks server what's missing, uploads only new chunks, then commits a file version (list of hashes) with CAS on the base version. Chunk store is content-addressed and refcounted; journal + notifications drive other devices."
},
{
  id: "log-storage",
  name: "Distributed Commit Log (Kafka-style)",
  tag: "Log",
  tagline: "Partitioned, replicated append-only logs with tiered storage for streaming and event sourcing.",
  scale: [["Throughput","GB/s per cluster"],["Partitions","100k+"],["Replication","RF=3, ISR"],["Retention","days to years"],["Latency","ms"]],
  requirements: [
    "Durable ordered append and sequential read by offset, per partition",
    "Millions of msgs/s, many independent consumer groups replaying at will",
    "Survive broker failure with no acknowledged-data loss",
    "Cheap long retention via tiered storage"
  ],
  layers: [
    {title:"Clients", nodes:[{n:"Producers",d:"Batching, compression, idempotent/transactional"},{n:"Consumer groups",d:"Pull by offset; partitions assigned within a group"}]},
    {title:"Control plane", nodes:[{n:"Controller quorum (KRaft/Raft)",d:"Topic metadata, partition leaders, ISR changes"}]},
    {title:"Brokers", nodes:[{n:"Partition leader",d:"Serves produce/fetch for its partitions"},{n:"Followers (ISR)",d:"Fetch from leader, replicate log"},{n:"Segment files + sparse index",d:"Append-only segments, page cache, zero-copy sendfile"}]},
    {title:"Tiered storage", nodes:[{n:"Remote object store",d:"Closed segments offloaded; local disk keeps hot tail"}]}
  ],
  flows: {
    "Produce": [
      "Producer picks partition (key hash or sticky), batches and compresses records",
      "Leader appends to the active segment (sequential write, page cache)",
      "Followers fetch and append; high-water mark advances when all ISR have the record",
      "With acks=all the producer is acked after HW advances; min.insync.replicas guards against shrinking ISR"
    ],
    "Consume": [
      "Consumer fetches from an offset; broker uses sparse index to find the segment position, sends via zero-copy",
      "Consumer commits offsets to an internal compacted topic; group rebalancing reassigns partitions",
      "Old offsets served from tiered remote storage transparently"
    ],
    "Failover": [
      "Controller detects leader loss, picks a new leader from the ISR, bumps leader epoch",
      "Followers truncate to the epoch's start offset to remove divergent tail, then continue fetching"
    ]
  },
  deepDives: [
    {t:"Why it is fast", b:"Strictly sequential disk I/O, OS page cache instead of an app cache, batching + compression, zero-copy sendfile. Partitions provide parallelism; ordering is only guaranteed within a partition."},
    {t:"ISR and durability", b:"Acknowledged records exist on every ISR member. Unclean leader election (choosing an out-of-sync replica) trades durability for availability and should be off for critical data."},
    {t:"Exactly-once", b:"Idempotent producers (producer id + sequence) dedup retries; transactions atomically write to multiple partitions and consumer offsets; consumers read committed only."},
    {t:"Compaction and retention", b:"Time/size retention deletes whole segments cheaply. Log compaction keeps the latest value per key, making the log a changelog/table (state store, CDC)."}
  ],
  failures: [
    ["Leader broker dies","New leader from ISR, epoch bump, follower truncation"],
    ["Slow follower","Dropped from ISR; rejoins after catching up"],
    ["Consumer dies","Group rebalance; resume from last committed offset (at-least-once)"],
    ["Disk full / hot partition","Tiered storage offload, partition reassignment, key re-design"]
  ],
  tradeoffs: [
    ["Replication","ISR-based, leader per partition","High throughput; durability tuned via acks and min ISR"],
    ["Delivery","At-least-once default, EOS optional","Cost vs duplicate handling"],
    ["Ordering","Per-partition only","Scales horizontally; global order needs a single partition"],
    ["Storage","Local + tiered remote","Fast tail reads, cheap infinite retention"]
  ],
  cheat: "Partitioned append-only log, leader + ISR replication, high-water mark, leader epochs for safe failover. Sequential I/O + page cache + zero-copy for speed. Tiered storage for retention. Idempotence + transactions for exactly-once."
}
];

/* Cross-pattern comparison table */
window.COMPARE = {
  cols: ["Pattern","Unit of data","Access","Consistency","Redundancy","Metadata","Typical latency","Best for"],
  rows: [
    ["Object store","Immutable object (KB-TB)","HTTP key/value","Strong (R-A-W)","EC 1.4x (large), 3x (small)","Sharded Raft KV","10-100 ms","Backups, media, data lakes"],
    ["Block store","4 KiB block","Virtual disk","Linearisable per volume","3x primary-backup","Raft coordinator","< 1 ms","VM disks, databases"],
    ["Distributed FS","Large block (64-256 MB)","POSIX-ish / HDFS API","Strong namespace, append data","3x rack-aware / EC cold","In-RAM master (+HA)","10-100 ms","Analytics, batch"],
    ["KV / LSM","Row / value","get/put by key","Tunable (eventual to strong)","N replicas, quorum","Gossip + ring","1-10 ms","Online serving, sessions"],
    ["Sync / Dedup","Content-addressed chunk","File sync API","Per-account strong","EC object store + refcount","Sharded SQL","seconds (sync)","Cloud drive, backup"],
    ["Commit log","Record in partition","Offset-based append/fetch","Per-partition order","ISR (RF=3) + tiered","Controller quorum","ms","Streaming, event sourcing"]
  ]
};

/* Reusable concepts that appear across patterns */
window.CONCEPTS = [
  {t:"Erasure coding vs replication", b:"Replication: simple, fast reads and repair, 3x cost. EC (RS/LRC): ~1.4-1.5x cost, tolerates multiple losses, but heavier repair and small-write penalty. Use replication for hot/small data, EC for large/cold."},
  {t:"Metadata/data separation", b:"Small hot transactional metadata in a consistent KV; bulk bytes on dumb dense nodes. Commit metadata last to get atomic visibility."},
  {t:"Append-only + compaction", b:"Sequential writes are fast on HDD/SSD and make crash recovery simple. Space is reclaimed later by compaction / GC."},
  {t:"Quorums and fencing", b:"R+W>N, Raft/Paxos for linearisability, epochs/terms to fence stale leaders and prevent split-brain."},
  {t:"Checksums and scrubbing", b:"End-to-end CRC at write, verify at read, scrub in the background, repair from redundancy."},
  {t:"Failure domains", b:"Spread replicas/shards across node, rack, AZ. Size the code so losing one domain stays within the redundancy budget."},
  {t:"Throttled repair", b:"Prioritise stripes closest to data loss, rate-limit to protect foreground latency."},
  {t:"Garbage collection", b:"Transactional tombstones for logical deletes + safety-windowed orphan scavenging for crash leftovers + compaction for dead space."}
];
