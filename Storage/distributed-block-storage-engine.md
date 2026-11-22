# Distributed Block Storage Engine (EBS-like) — System Design

> **Core challenge:** sub-millisecond latency and high IOPS on a replicated, network-attached block device, with **crash-consistent snapshots** and **self-healing** that never starves foreground I/O.

---

## At a Glance

| Aspect | Design |
|---|---|
| Unit of replication | 16 GiB **partition** = 3 replicas in 3 failure domains (declustered placement) |
| Write path | Client → primary → WAL (PLP NVMe) → parallel backups; **ack when 2 of 3 are durable** |
| Consistency | Linearizable per volume; epoch fencing + leases prevent split-brain |
| On-node layout | WAL → in-memory index → copy-on-write B+tree over 4 MiB extents of 4 KiB blocks |
| Snapshots | O(1) root pin; client-ordered epoch cut; incremental, content-addressed upload to object storage |
| Self-healing | Coordinator bumps epoch, promotes highest-LSN ISR member, parallel repair from many peers |
| Protecting foreground I/O | Priority classes + AIMD throttle on foreground p99 + token buckets |
| Targets | p99 write < 1 ms · up to 256k IOPS / volume · 99.999% durability · 99.99% availability |


---

## Table of Contents

**Part I: Foundations**
1. [Requirements](#1-requirements)
2. [Capacity & Latency Budget](#2-capacity--latency-budget)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Data Model & Placement](#4-data-model--placement)

**Part II: Data Path**
5. [Write Path & Replication](#5-write-path--replication)
6. [Read Path](#6-read-path)
7. [On-Node Storage Engine](#7-on-node-storage-engine)

**Part III: Snapshots**
8. [Copy-on-Write Snapshots](#8-copy-on-write-snapshots)

**Part IV: Control Plane & Reliability**
9. [Control Plane](#9-control-plane)
10. [Failure Handling & Re-replication](#10-failure-handling--re-replication)
11. [Data Integrity](#11-data-integrity)

**Part V: Operating the System**
12. [QoS, Multi-tenancy, Security](#12-qos-multi-tenancy-security)
13. [Observability & Testing](#13-observability--testing)

**Part VI: Wrap-up**
14. [Trade-offs & Alternatives](#14-trade-offs--alternatives)
15. [Interview Cheat Sheet](#15-interview-cheat-sheet)


---

## 1. Requirements

### Functional
| # | Requirement |
|---|---|
| F1 | Create / delete / resize volumes (1 GiB – 64 TiB) |
| F2 | Attach to one compute instance as a block device (NVMe / virtio-blk); optional multi-attach |
| F3 | `read(lba, len)`, `write(lba, len, data)`, `flush`, `trim/discard`, `write-zeroes` |
| F4 | Point-in-time **snapshots** (instant, crash-consistent), stored durably in object storage |
| F5 | Create volume from snapshot (lazy restore: usable immediately) |
| F6 | Online volume resize, online type/IOPS change |
| F7 | Encryption at rest and in transit, per-volume keys |

### Non-Functional
| Property | Target |
|---|---|
| Latency (4 KiB, QD1) | p50 < 300 µs, **p99 < 1 ms**, p99.9 < 3 ms (SSD tier) |
| IOPS / throughput per volume | up to 256k IOPS, 4 GB/s (provisioned) |
| Durability | ≥ 99.999% annual (≈ 3 replicas + snapshots in 11-9s object store) |
| Availability | 99.99% (volume), single-AZ; snapshots give cross-AZ/region recovery |
| Consistency | **Linearizable** per volume: acked write is visible to every later read, survives any single failure |
| Snapshot | O(1) creation, no visible I/O pause (< 1 RTT), crash-consistent |
| Repair | Restore full redundancy of a failed node's data in minutes, < 10% foreground latency impact |

### Out of Scope
Filesystem layer, cross-region sync replication, application-consistent snapshots (needs guest agent / fsfreeze, mention only).

---

## 2. Capacity & Latency Budget

### Fleet sizing (one region, illustrative)
```
Volumes                    : 1 M, avg 500 GiB            → 500 PB logical
Replication factor 3       : 1.5 EB raw
Storage node               : 8 × 7.68 TB NVMe ≈ 61 TB    → ~25 k nodes (at 70% fill: ~35 k)
Avg load per volume        : 1 k IOPS (70/30 R/W)        → ~1 B IOPS fleet; ~300 M write IOPS
Write amplification        : 3x network, ~3x+ disk (WAL + apply) → plan NVMe endurance (DWPD) accordingly
Per-node                   : ~30-100 k IOPS sustained, 25-100 Gbps NIC
```

### Latency budget for one 4 KiB write (target < 1 ms p99, ~250 µs p50)
| Stage | p50 | Notes |
|---|---|---|
| Client driver → primary (RDMA/ SRD / kernel-bypass TCP) | 25–50 µs | one RTT, in-AZ |
| Primary WAL append (PLP NVMe, group commit) | 15–30 µs | power-loss-protected SSD or NVDIMM/persistent memory |
| Primary → backups (parallel) + backup WAL persist | 60–100 µs | slowest of 2 backups dominates |
| Ack back to client | 25–50 µs | |
| Software overhead (SPDK/io_uring, polling, no context switch) | 20–40 µs | |
| **Total** | **~150–270 µs** | tail budget absorbs queuing, GC, retransmits |

**Design consequences:** user-space polled I/O stack (SPDK / io_uring), no locks on hot path, thread-per-core, avoid memory copies, no synchronous metadata write on the write path beyond the WAL.

---

## 3. High-Level Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │               CONTROL PLANE                  │
                         │  API / Volume Mgr   Snapshot Mgr   Placement │
                         │  ┌────────────────────────────────────────┐  │
                         │  │ Cluster Coordinator (per cell, Raft x5)│  │
                         │  │ volume→partition map, epochs, leases,  │  │
                         │  │ membership, repair scheduler           │  │
                         │  └────────────────────────────────────────┘  │
                         └───────────▲────────────────────▲─────────────┘
                     heartbeat/epoch │                    │ manifests
                                     │                    │
┌───────────────┐   NVMe/virtio    ┌─┴──────────────┐    │
│ Guest VM / OS │──────────────────► Client Driver  │    │
└───────────────┘  (offload card   │ (volume map    │    │
                    or hypervisor) │  cache, retry, │    │
                                   │  epoch tags)   │    │
                                   └──┬──────────┬──┘    │
                      data plane (RDMA│/TCP)     │       │
                        ┌─────────────▼──┐  ┌────▼───────┴─┐
                        │ Storage Node A │  │ Storage Node B│  ... (partition = 3 replicas
                        │  PRIMARY p17   │──►  BACKUP  p17  │       in 3 failure domains)
                        │ ┌───────────┐  │  │              │
                        │ │ WAL (NVMe)│  │  └──────────────┘
                        │ │ Extent map│  │  ┌──────────────┐
                        │ │ Data store│  │──►  BACKUP  p17  │ Node C
                        │ └───────────┘  │  └──────────────┘
                        └───────┬────────┘
                                │ incremental dirty chunks (throttled, background)
                        ┌───────▼──────────────────────┐
                        │ Object Storage (S3-like)     │  snapshots, manifests
                        └──────────────────────────────┘
```

**Planes**
- **Data plane:** client driver ↔ storage nodes. Never touches the coordinator on the I/O path (map cached, invalidated by epoch mismatch).
- **Control plane:** low-QPS, strongly consistent (Raft). Owns membership, epochs, placement, repair, snapshots.
- **Cellular design:** the fleet is split into independent *cells* (≈ 500–2000 nodes, own coordinator). Limits blast radius; coordinator state stays small.

---

## 4. Data Model & Placement

### Hierarchy
```
Volume (≤64 TiB, volume_id)
 └─ Partition  (fixed 16 GiB logical range; unit of replication & failover)   → "replica group"
     └─ Extent (4 MiB physical allocation unit; unit of repair & snapshot upload)
         └─ Block (4 KiB; unit of LBA addressing, checksumming)
```
- A volume with 1 TiB has 64 partitions → I/O is striped across 64 replica groups (×3 nodes), so one volume can use hundreds of NVMe drives' IOPS.
- Partition size is a trade-off: small → more metadata & better parallel repair, large → fewer coordinator entries. 16 GiB x 1 M volumes x ~30 partitions avg ≈ 30 M partitions per region; per cell ≈ 1 M — fits in a Raft-replicated in-memory map (~200 B/entry).

### Placement rules (Coordinator)
1. 3 replicas in **3 distinct failure domains** (rack / power / ToR; AZ is the outer boundary).
2. **Declustered placement:** replicas of one node's partitions are scattered across *all* other nodes (random with power-of-two-choices weighted by free capacity & IOPS headroom). Result: when a node dies, thousands of peers each copy a little → repair time ∝ 1/N.
3. Balance capacity, IOPS and NIC bandwidth, not just bytes.
4. Hot-spot rebalancing: move partitions in background using the same re-replication machinery.

### Partition metadata (in Coordinator)
```
partition_id → {
  volume_id, lba_range,
  epoch           (monotonic, bumped on any membership/primary change),
  primary         node_id,
  replicas        [node_id × 3],
  isr             [subset of replicas currently in-sync],
  state           NORMAL | DEGRADED | REPAIRING,
  committed_lsn   (last checkpointed by primary, coarse)
}
```

---

## 5. Write Path & Replication

### 5.1 Choice: primary-backup, parallel fan-out, ISR + epoch fencing
Options considered:

| Scheme | Write latency | Read | Failure handling | Verdict |
|---|---|---|---|---|
| **Primary → parallel backups, ack when all ISR persisted (min ISR = 2)** | 1 RTT + max(backup) | Primary serves (linearizable) | Coordinator picks new primary from ISR, epoch fence | ✅ **Chosen** |
| Majority quorum (Raft/Paxos per partition) | 1 RTT + 2nd-fastest | Leader read w/ lease | Built-in leader election | Good; masks 1 slow replica (better tail), but Raft per 30 M partitions is heavy |
| Chain replication (CRAQ) | N hops serial (~3× RTT) | Any node (tail/clean) | Needs master reconfig | Higher latency, great read scale-out; rejected for sub-ms writes |

**Compromise worth stating in interview:** run quorum-style acknowledgement (2 of 3 durable) for tail latency **while** keeping a lightweight single-decree-per-epoch membership decided by the coordinator, not a full Raft log per partition. This yields Raft-like tail latency with cheap per-partition state (just `epoch`, `lsn`).

### 5.2 Write protocol
```
Client driver                Primary (epoch e)             Backup 1 / Backup 2
     │ WRITE(vol, lba, len, data, epoch=e, vol_seq, snap_epoch) │
     ├───────────────────────────►│                              │
     │                            │ 1. validate epoch & lease    │
     │                            │ 2. assign LSN = ++lsn        │
     │                            │ 3. ──replicate(LSN,data)────►│  (parallel, RDMA write/send)
     │                            │ 3'. append to local WAL ─┐   │ 4. append to local WAL,
     │                            │      (group commit)      │   │    fsync/PLP flush
     │                            │ ◄─────── ACK(LSN) ───────┴───┤
     │                            │ 5. when local + ≥1 backup (≥2 of 3 incl. self)
     │                            │    durable AND all earlier LSNs durable → COMMIT
     │◄── ACK ────────────────────┤ 6. update in-memory index; async apply to extent store
```
Details:
- **LSN** = (epoch, seq). Ordering inside a partition is the LSN order; commit is *in order* (prefix-commit) so the log never has holes in the committed prefix.
- **Acknowledgement rule:** ack when ≥2 of 3 copies are durable in WAL. The third copy is still in flight; if it times out (e.g., 5–50 ms adaptive) the replica is dropped from the ISR via the coordinator (see §10). `min_isr=2` ensures an acked write always exists on ≥2 nodes → survives any single failure.
- **Fencing:** every message carries `epoch`. Replicas reject lower epochs. A deposed primary can't commit because backups reject it; primary also holds a *lease* from the coordinator (renewed by heartbeat, shorter than the failover timer) so it stops serving reads before a new primary is elected.
- **Group commit & batching:** WAL entries from many writes are combined into one NVMe write (up to 128 KiB / 20–50 µs window, adaptive: no wait at low QD). Network replication is batched the same way.
- **Idempotency & retries:** client assigns `(client_id, volume_seq)`; primary dedups retransmits (window table) so a retry after timeout or failover never double-applies. Overwrites are idempotent anyway, but dedup matters for ordering with later writes.
- **Ordering guarantees:** writes to overlapping LBAs are serialized by LSN; non-overlapping writes may complete out of order (like a real disk) — flush/FUA semantics are honored (`flush` = wait until all prior writes committed; FUA = commit this write before ack).
- **Torn write protection:** WAL record = header(LSN, lba, len, snap_epoch) + payload + CRC32C. Partial tail is detected & truncated at recovery. 4 KiB atomicity at the block layer.
- **Large writes** are split on partition boundaries; each partition commits independently (a multi-partition write is **not atomic**, same as a physical disk). Order dependencies are the guest's responsibility (it waits for acks).

### 5.3 WAL device
- Dedicated NVMe namespace (or the same drive with a log-structured region) on **power-loss-protected** SSDs so that a write completion = durable, no flush needed. Without PLP, you'd need FLUSH (adds 100s of µs) — a hardware requirement, not a software one.
- Optional: NVDIMM / CXL persistent memory / battery-backed DRAM as a **write buffer tier** for single-digit µs persistence.
- Circular log per partition-shard (or per-core log shared by many partitions, with per-partition index) to keep writes sequential, avoiding write amplification & random IO.

---

## 6. Read Path

```
Client → Primary (partition owner) → in-memory index lookup
    hit in WAL-resident / write-back cache → return
    else → extent map lookup → NVMe read (4 KiB…) → verify CRC → return
```
- **Default: primary-only reads** → linearizable without coordination (primary has lease + all committed data).
- **Replica reads (optional, relaxed):** a backup may serve a read if the client passes its last-acked LSN and the backup has `applied_lsn ≥` that value (read-your-writes), for read-heavy volumes/multi-attach. Also used as *hedged read* if the primary shows slow I/O.
- **Page cache:** user-space block cache (LRU/ARC) in node DRAM; the guest OS cache sits above. Small cache since NVMe is fast; mainly helps read-after-write for just-written WAL data not yet applied.
- **Lazy-restored volumes:** read of a not-yet-hydrated extent → fetch from object store (parallel range GET), write-through into the extent store, return. See §8.5.
- **Checksum mismatch** → read from a backup, return good data, repair local copy asynchronously.

---

## 7. On-Node Storage Engine

```
 incoming write ─► WAL ──(committed)──► in-memory Index (LBA → location)
                         │                   │
                         │ async apply       │ persisted by checkpoint
                         ▼                   ▼
                    Extent store      Persistent B+tree / extent map  (CoW, versioned by snap epoch)
```

### 7.1 Components
| Component | Role |
|---|---|
| **WAL** | Durability & ordering. Truncated after data is applied + index checkpointed. |
| **Memtable / write-back cache** | Latest committed-but-unapplied blocks, so reads see them immediately. |
| **Extent map (index)** | LBA → (physical extent id, offset, len, birth_epoch, crc). Persistent copy-on-write B+tree per partition; hot path uses an in-memory sorted structure (skip list / ART) rebuilt from the checkpoint + WAL replay. |
| **Extent store** | Raw NVMe space carved into 4 MiB extents, free-space managed by a bitmap/buddy allocator; data placed in 4 KiB blocks with CRC trailers. |
| **Applier** | Background thread draining WAL→extents in LSN order, batching, coalescing overwrites. |
| **Checkpointer** | Periodically writes a consistent B+tree root + `applied_lsn`; allows WAL truncation & fast restart. |
| **GC / Compactor** | Frees blocks no longer referenced by any snapshot; defragments partially-live extents. |

### 7.2 Update strategy: Redirect-on-Write (ROW) with extent granularity
- **Live volume with no snapshot pending on a block** → overwrite in place (optimizes sequential locality, avoids write amp).
- **First write to a block after a snapshot** (block's `birth_epoch < current_snap_epoch`) → **do not overwrite**; allocate new physical block, write there, and update live map → old physical block stays referenced by the snapshot map. (ROW is the efficient form of CoW: one write instead of read-old + write-old-copy + write-new.)
- Subsequent writes to the same block in the same epoch are in place (birth_epoch == current).

### 7.3 Recovery on node restart
1. Load last checkpoint (B+tree root, `applied_lsn`).
2. Replay WAL from `applied_lsn` to the first invalid/CRC-failed record → rebuild memtable and index.
3. Report `last_durable_lsn` to the coordinator; coordinator decides role (primary/backup/needs catch-up).
Restart time is bounded by checkpoint interval (e.g., ≤ 30 s of WAL ≈ seconds to replay).

---

## 8. Copy-on-Write Snapshots

### 8.1 Idea
- The partition index is a **persistent (immutable-node, copy-on-write) B+tree**. A snapshot = *keep the current root pointer* and bump the epoch: **O(1), no data copied, no I/O pause**.
- Every mapping carries `birth_epoch`. Physical blocks are reference-tracked by epoch ranges `[birth, death)` (ZFS "dead list" style), so we know when no snapshot can reach a block.

```
Epoch 5 (live)                          take snapshot S1  → freeze root R5, live epoch = 6
 Live root R5 ──► LBA 0→P10 (e3)                           Live root R6 (shares subtrees with R5)
                  LBA 1→P11 (e5)                           write LBA 1 :  LBA1→P42 (e6)   [P11 kept for S1]
                  LBA 2→P12 (e2)                           LBA 0→P10, LBA 2→P12 shared (no copy)
 S1 → R5 (immutable)
```

### 8.2 Crash-consistent snapshot across a multi-partition volume
A volume spans many partitions; the snapshot must be a *consistent cut*: if write B was issued after write A was **acknowledged**, then B ∈ snapshot ⇒ A ∈ snapshot.

Protocol (no global lock, ≈1 RTT, no I/O stall):
1. Snapshot Mgr asks the **client driver** (the single writer & ordering point of an attached volume) to cut epoch: `snap_epoch: N → N+1`. For detached volumes, no client → trivially consistent.
2. Driver atomically flips its local `snap_epoch` — from this instant every new write is tagged `N+1`, writes already issued are tagged `N`.
3. Driver broadcasts `SEAL(N)` to all partitions of the volume in parallel (also carried implicitly on the first `N+1` write).
4. A partition, on seeing the first `N+1` tag or `SEAL(N)`: switches live epoch to `N+1`, freezes index root for epoch `N` (new root, CoW from here on).
5. Partition seals `N` once the marker arrived and every write tagged `N` that was issued earlier has been committed or timed-out; the driver guarantees no more `N`-tagged writes will be sent after SEAL is sent. Partition replies `SEALED(N, root, lsn)`.
6. Snapshot Mgr marks the snapshot **COMMITTED (point-in-time = cut)** when all partitions replied (`pending` state visible to user until then — like EBS `pending→completed`).

Why it's crash-consistent: acked writes (which a dependent write could causally depend on) are tagged by a monotonic per-volume epoch from a single ordering point, so the snapshot is a **prefix-closed** cut equal to the image you'd see after a power failure at that instant. In-flight, un-acked writes may fall on either side, which a power failure could also produce.
For **multi-attach** volumes there's no single ordering point; snapshot requires a coordinated quiesce (brief barrier through the coordinator with a hybrid logical clock) → documented as weaker/optional.
For **application-consistent** snapshots: guest agent fsfreeze / DB quiesce → then run the same protocol.

### 8.3 Incremental upload to object storage
```
snapshot S_n (frozen root)  vs  S_{n-1} (frozen root)
     │   diff = blocks with birth_epoch ∈ (epoch(S_{n-1}), epoch(S_n)]   ← free: stored in the index
     ▼
 changed 4 KiB blocks → coalesced into 512 KiB–4 MiB chunks aligned to extents
     │  chunk_id = SHA-256(content); skip if present (dedup, also handles re-upload retries)
     ▼
 compress (LZ4/ZSTD) → encrypt (volume DEK) → PUT (multi-part, parallel across partitions' replicas)
     ▼
 manifest S_n: partition → [ (lba_range, chunk_id, offset) … ]  — a *full* logical manifest that
 references old chunks for unchanged ranges (no chain walk at restore time)
```
- **Dirty tracking is derived from the CoW index** (`birth_epoch` compare) — no separate dirty bitmap or scan, no tracking overhead on the write path.
- **Who uploads:** one replica per partition (the *least loaded*; typically a backup so the primary's tail is not affected) reads blocks from the immutable snapshot view; throttled by the same background-I/O scheduler (§10.4).
- The snapshot is **durable-ready** once the manifest + all chunks are in object storage; it is then "completed". Until then, the local frozen root pins the data (the volume can still be used; space overhead grows with change rate — alarm & backpressure on snapshot lag).
- **Restart/resume:** upload progress per partition is checkpointed in the coordinator; idempotent PUTs (content-addressed) make retries safe.

### 8.4 Snapshot deletion
- Chunks reference-counted in the snapshot catalog (`chunk_id → refcount` or mark-sweep over manifests in a background job). Deleting S_k: drop manifest, decrement chunks, delete 0-ref chunks (soft delete + grace period).
- Local frozen roots: free physical blocks whose epoch range `[birth, death)` contains no remaining snapshot epoch (GC in background, rate-limited).

### 8.5 Restore (volume from snapshot) — lazy hydration
1. Create volume with partition index entries marked **"remote(chunk_id)"** — O(partitions), seconds.
2. Volume is **immediately attachable**. Read miss → fetch chunk (+ readahead) from object store, write into extent store, and update the index to "local".
3. Writes to unhydrated ranges: write goes to WAL/new block normally; reads of that block see local data; hydration skips blocks already overwritten (index has a newer birth epoch).
4. Background **prefetch** hydrates in a bandwidth-limited manner; optional "fast snapshot restore" pre-hydrates a pool of extents to avoid first-touch latency.
5. First-read penalty (~ms to tens of ms) is the known trade-off, documented.

---

## 9. Control Plane

| Service | Responsibility | State |
|---|---|---|
| **API / Volume Manager** | create/delete/resize/attach; IOPS tiers; idempotent workflows | metadata DB (Raft-based or Dynamo-like) |
| **Cluster Coordinator (per cell)** | Raft-replicated map: node membership, partition → replicas, epochs, ISR, leases; **serializes** ISR/epoch changes (CAS) | in-memory + Raft log (~GBs) |
| **Placement Service** | picks nodes for new partitions & repair targets | derived from coordinator + telemetry |
| **Repair Scheduler** | the priority queue & budgets from §10 | coordinator-adjacent, recoverable |
| **Snapshot Manager** | snapshot state machine (`CREATING → PENDING(upload) → COMPLETED → DELETING`), catalog, manifests, GC | metadata DB + object store |
| **Telemetry/QoS** | health, latencies, capacity → placement & throttle | time-series DB |

Design points:
- **Coordinator off the hot path.** Client caches `partition → (primary, epoch)`; only on `STALE_EPOCH`/timeout does it ask. Storage nodes cache their role & epoch plus a lease.
- **Small cells** keep Raft group size and recovery bounded; a cell failure affects only its volumes.
- **Volume attach** gives the client driver a signed volume token (volume_id, partition map version, keys wrapped by KMS).
- **Resize:** add partitions at the end (online), update map version; shrink not supported.

---

## 10. Failure Handling & Re-replication

### 10.1 Failure detection
| Mechanism | Detects | Timer |
|---|---|---|
| Node → coordinator heartbeat (+ lease renewal) | node death / network cut | 1 s heartbeat, ~5–10 s suspicion (phi-accrual adaptive) |
| In-band replication timeouts (primary ↔ backup) | replica slow/dead on data path | 5–50 ms adaptive → *immediately* reports to coordinator |
| Client driver timeouts | primary unreachable | retries with hedging, asks coordinator for new map |
| Per-device health (SMART, I/O latency outliers) | **gray failure** (slow disk/NIC) | continuous; eject on p99 > threshold for N windows |

### 10.2 Cases
**A. Backup fails/slow (writes keep flowing):**
1. Primary can't get a 2nd ack?  With 3 replicas, ack on primary + the other backup still satisfies the rule → no client-visible hiccup.
2. Primary asks the coordinator to shrink ISR (`epoch++`, `isr = {primary, healthy backup}`) — conditional update guarded by epoch. Writes continue with `min_isr=2`. State = **DEGRADED**.
3. If the failed replica returns quickly (**< T_delay**, default ~10 min; transient reboot/network blip): **log-based catch-up** — primary ships WAL (or changed-extent delta since the replica's `last_lsn`), replica re-enters ISR. Cheap; avoids a mass copy.
4. If it doesn't return in T_delay → declare **permanently lost** → full re-replication (§10.3). T_delay prevents repair storms on rolling reboots / short network events.

**B. Primary fails:**
1. Coordinator observes missed heartbeat / lease expiry (the old primary self-fences when its lease lapses, so lease < failover timer).
2. Coordinator picks new primary from the ISR with the **highest durable LSN** (any acked write is on ≥2 of 3 nodes, so at least one ISR member has it), `epoch++`.
3. New primary reconciles: sync with the other ISR member, truncate any uncommitted tail beyond the agreed commit point (replica with higher LSN ships its tail; un-acked entries may be discarded since never acked to client).
4. Clients get `STALE_EPOCH` on the next I/O → refresh the map → resend (dedup'd by `(client_id, seq)`).
5. Typical unavailability for the partition: 1–10 s (dominated by failure detection; lowered with in-band detection → ~sub-second to a few seconds).

**C. Two of three replicas lost:** partition has 1 copy → **highest repair priority** and writes pause if `min_isr=2` can't be met (choose: **fail-stop** to protect durability; optionally allow `min_isr=1` as an operator-driven policy). Restore from the surviving replica + snapshot in the worst case.

**D. Network partition:** only the side that can reach the coordinator & hold a lease can serve; epoch fencing + lease guarantee no split-brain (two primaries) — `lease_duration < coordinator failover timeout` with bounded clock drift.

**E. Coordinator failure:** Raft; data plane keeps serving with cached maps and existing leases (leases are renewed through coordinator heartbeats, so they lapse after the TTL once the coordinator is unreachable). If majority lost > lease TTL, primaries stop serving (CP) — mitigated by cell design & 5-node Raft across fault domains.

**F. Whole-rack/AZ failure:** declustered placement & rack-aware placement mean at most 1 replica of any partition is in a rack; AZ loss → restore from snapshots in another AZ (EBS is AZ-scoped).

### 10.3 Re-replication (repair) with the coordinator
```
Coordinator Repair Scheduler
  1. Failure → enumerate affected partitions (from node→partitions index)
  2. Priority queue ordered by (remaining healthy replicas asc, time-degraded desc, volume tier)
        1 replica left   ──► P0 (urgent, maximum budget)
        2 replicas left  ──► P1 (normal, throttled)
  3. For each partition choose target node (placement constraints, capacity, load, NOT busy repairing)
  4. Create "learner" replica on target:  epoch++ , state = LEARNER (not in ISR, not counted for acks)
  5. Primary tees all *new* writes to the learner's WAL (so it never falls behind)
  6. Background bulk copy of extents from a healthy source (any in-sync replica — pick the
     least-loaded; spread sources across the surviving replicas) with version check:
         copy extent only if source.version > learner.version  (live writes always win)
     Snapshot-referenced blocks are copied by (block, birth_epoch) so frozen roots are preserved.
  7. When learner.lsn ≥ primary.lsn − ε and extent copy complete → verify (checksum sample/full) →
     coordinator promotes learner into ISR (epoch++) → state NORMAL
  8. Old node's data (if it returns later) is garbage collected after an epoch check (stale replica never rejoins with old data blindly)
```
**Why it's fast:** with declustered placement, a failed 61 TB node's ~3.8 k partitions have sources and targets spread across ~hundreds of peers. Each peer copies ~ tens of GiB at a throttled ~100–500 MB/s → full recovery in minutes instead of hours. (Rebuild time ≈ data_lost / (N_peers × per-peer repair_rate).)

### 10.4 Not starving foreground I/O (the key trade-off)
Layered defenses:

1. **Per-node I/O scheduler with priority classes** (SPDK/blk-mq QoS):

   | Class | Examples | Priority |
   |---|---|---|
   | P0 foreground | client reads/writes, WAL, replication | strict priority, reserved IOPS/BW |
   | P1 urgent repair | partitions with 1 replica | guaranteed minimum share |
   | P2 normal repair, snapshot upload | | weighted fair share of *leftover* |
   | P3 GC, scrub, rebalancing | | scavenger |

2. **Adaptive rate limit (AIMD controller driven by foreground latency):**
   ```
   every 100 ms:
     if fg_p99_latency > target (e.g., 1.2×SLO) or device queue depth > threshold:
         bg_rate = bg_rate × 0.5            # multiplicative decrease
     else if headroom:
         bg_rate += step                    # additive increase, up to the per-node cap
     bg_rate = max(bg_rate, min_floor_for_urgency)
   ```
   Floor is higher for P0-urgency repair so durability isn't sacrificed indefinitely.
3. **Token buckets** on three resources: NVMe bandwidth/IOPS, NIC bandwidth (separate QoS queue / traffic class, DSCP / PFC-safe), CPU (dedicated cores for background, pinned).
4. **Global concurrency caps from the coordinator:** ≤ k concurrent repairs per node as *source* and per node as *target*; ≤ x% of cell bandwidth; avoid selecting hot nodes as sources.
5. **Source-side read from the least-loaded replica** (not the primary), preferably backups; throttle at both ends (sender & receiver backpressure).
6. **Small I/O chunks with preemption:** repair reads 256 KiB–1 MiB slices so a foreground I/O never waits behind a large background transfer (NVMe weighted round-robin / separate submission queues per class if the drive supports).
7. **Time-based policies:** raise budgets in off-peak windows; for non-urgent rebalancing only.
8. **Backpressure the other way too:** if repair falls behind a durability-risk threshold (many partitions with 1 copy), the coordinator **escalates** budget (explicit durability vs. performance policy) and pages operators.
9. **Surge control:** stagger — when many nodes fail (rack), prioritize by redundancy level; stop *planned* maintenance/rebalancing.

### 10.5 Gray failure & slow replicas
- Quorum-style 2/3 ack automatically hides one slow replica → tail latency protection.
- Outlier detection (peer-relative latency, EWMA, ≥ N× median) → proactively move the slow node out of primary roles → eject → repair.
- Client hedged reads/writes retry on alternate replica after a p99-ish timer (with dedup).

---

## 11. Data Integrity

- **End-to-end checksums:** CRC32C (hardware) computed at the client driver, carried in each write, stored with each block, verified on read at the primary and in the driver. Optionally T10-PI style.
- **Scrubbing:** background, low-priority P3 scan; compares replica checksums per extent; repairs from a good replica. Rate-limited to ≈ complete once every 2–4 weeks.
- **Silent corruption / bit-rot:** detected on read or by scrub → repair from peer; if all replicas bad → restore from snapshot, alert.
- **Torn writes / lost writes:** WAL CRC, monotonic LSN, `flush`/FUA semantics; verify firmware lies with periodic fault-injection tests.
- **Metadata integrity:** checksum in B+tree node pointers (Merkle-style), double-write of superblock/checkpoint root.
- **Durability math (rough):** AFR 1–2% per drive, repair time ≈ minutes → P(second & third failure in window) ≈ 1e-9–1e-11/yr per partition (before accounting for correlated failures — rack/firmware). Snapshots in 11-9s object store covers the correlated tail.

---

## 12. QoS, Multi-tenancy, Security

### QoS
- **Per-volume token buckets** for IOPS and throughput (provisioned) enforced **at the client driver / offload card** (first line) *and* at the primary (defense in depth).
- **Burst credits** for small/general-purpose volumes (earn when idle).
- **Noisy neighbor protection:** per-node weighted fair queueing across volumes (DRR); admission control at placement time: sum of provisioned IOPS per node ≤ ~70% of its capability.
- I/O size normalization (e.g., 16 KiB = 1 IOPS-unit) so the accounting is fair.

### Security
- **Encryption at rest:** per-volume data key (DEK) wrapped by KMS CMK; AES-256-XTS in the storage node (or inline in NVMe SED / offload card). Keys exist in memory only; revocation = KMS disable.
- **In transit:** mTLS or hardware-offloaded encryption between client and storage nodes (and between replicas).
- **AuthZ:** attach tokens bound to instance identity; storage nodes validate volume capability + epoch.
- Snapshots encrypted with the volume DEK (or a snapshot-specific key) — cross-account share via key grants.

---

## 13. Observability & Testing

**Metrics:** per-volume & per-partition p50/p99/p99.9 latency by stage (client, net, WAL, replica ack, apply), IOPS/BW, queue depths, ISR size, % partitions degraded, repair backlog (bytes, partitions by priority), repair rate vs. foreground latency, snapshot upload lag, WAL fill %, space amp from snapshots, checksum errors, throttle events.
**Alarms:** partition with 1 replica > X min; repair backlog age; fg p99 > SLO; WAL > 80%; snapshot lag; node latency outliers.
**Tracing:** sampled end-to-end trace IDs across client → primary → backups.

**Testing:**
- **Deterministic simulation** of the replication/failover protocol (FoundationDB-style): random crashes, partitions, reordering, clock skew.
- **Jepsen-style linearizability checks** on the block API with fault injection (kill -9, power cut, `tc netem`, disk errors, slow disks).
- **Fault-injection on NVMe** (dm-flakey / SPDK error bdev): torn writes, bit flips, latency spikes.
- **TLA+ model** for epoch/ISR/primary election/snapshot cut protocol.
- **Game days:** rack failure, mass rolling reboot, coordinator failover while repairing.
- **Canary & staged rollouts** per cell; format versioning & forward/backward compatible on-disk formats.

---

## 14. Trade-offs & Alternatives

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Replication | Parallel primary-backup, 2/3 ack, ISR+epoch | Chain; full Raft per partition | Lowest write latency + tail-tolerance; cheap per-partition state |
| Reads | Primary only | Any replica / CRAQ | Linearizable & simple; opt-in replica reads |
| Snapshot technique | ROW on persistent B+tree | Block-level CoW (copy-old), LVM-style | 1 write vs 3 on first overwrite; O(1) snapshot |
| Dirty tracking | Derived from birth_epoch | Bitmap (CBT) | No extra write-path cost |
| Consistency cut | Client-ordered epoch tag | Global pause/quiesce | No I/O stall; correct for single-writer |
| Placement | Declustered | Mirrored pairs / RAID groups | Parallel rebuild, fast repair |
| Erasure coding | 3× replication on hot tier; EC (e.g., 8+3) for cold/snapshot | EC everywhere | EC inflates small-write latency (read-modify-write, more hops) |
| Repair throttling | AIMD on fg latency + priority floors | Fixed rate | Adapts to load while bounding durability risk |
| Failure policy at 1 replica | Fail-stop writes (min_isr=2) | Continue (min_isr=1) | Durability over availability (CP) |
| Delay before full rebuild | ~10 min + log catch-up | Immediate | Avoids repair storms from transient faults |
| Log medium | PLP NVMe / PMem | Fsync'd consumer SSD | Needed for µs durability |
| Snapshot storage | Object store, content-addressed chunks | Local snapshot copies | 11-9s durability, cheap, cross-AZ |

**Known limitations to call out:** snapshot space overhead grows with churn; first-read latency of lazily restored volumes; single-AZ scope; multi-attach consistency is weaker; partition-spanning writes aren't atomic.

---

## 15. Interview Cheat Sheet

**30-second summary:** *Volumes are striped into 16 GiB partitions, each a 3-replica group across failure domains. Writes go to the primary, which assigns an LSN, appends to a WAL on PLP-NVMe, replicates in parallel to two backups, and acks when 2 of 3 are durable — epoch fencing and leases prevent split-brain. Each node maps LBA→physical via a copy-on-write B+tree with birth epochs; a snapshot freezes the root (O(1)) and bumps an epoch tagged by the client driver, giving a crash-consistent cut across partitions; changed blocks (birth_epoch diff) upload incrementally to object storage. On failure, the coordinator bumps the epoch, promotes the highest-LSN ISR member, and re-replicates degraded partitions from many sources in parallel, throttled by a latency-aware priority scheduler so repair never starves client I/O.*

**Likely follow-ups & short answers**
- *Why not fsync on every write?* PLP NVMe makes write-completion durable; group commit amortizes; replication gives the second copy.
- *What if the primary acks then dies before backups persist?* Never acked — ack requires ≥2 durable copies, and new primary comes from ISR with highest LSN.
- *How do you avoid two primaries?* Coordinator-issued epoch + lease shorter than failover timeout; replicas reject stale epochs.
- *Why is a snapshot instant?* It just pins an immutable root of a CoW tree; no data moves.
- *How do you know what to upload?* `birth_epoch ∈ (prev_snap, this_snap]` straight from the index.
- *Consistency across partitions?* Client driver is the ordering point; epoch tag on every write + seal marker.
- *How do you keep repair from hurting users?* Priority classes, AIMD on foreground p99, token buckets for disk/NIC/CPU, small preemptible I/Os, coordinator concurrency caps, and urgency floors by redundancy level.
- *How long to rebuild a dead node?* Declustered placement: minutes, because hundreds of peers each copy a slice.
- *Why not chain replication?* 3 serial hops add latency; we prioritize write p99.
- *What about a slow disk?* 2/3 acks hide it; outlier detector evicts it; hedged reads.
- *Scale limits?* Cells bound coordinator size; partitions spread IOPS; metadata ~ O(partitions).

**Numbers to remember:** 4 KiB block · 4 MiB extent · 16 GiB partition · RF=3, min_isr=2 · p99 write < 1 ms · detection 1–10 s · rebuild delay ~10 min · repair BW floor/ceiling per node ~50–500 MB/s adaptively.
