# Data flow

## Collection

```mermaid
flowchart LR
    Config["sources.json<br/>Locations, engines, adapters"] --> Collector["Daily / manual / PR collection"]
    Qualification["Qualification feeds<br/>llama.cpp · vLLM"] --> Fetch["Resolve commit<br/>Fetch pinned JSON"]
    Benchmarks["Benchmark feed<br/>Lemonade leaderboard"] --> Fetch
    Collector --> Fetch
    Fetch --> Raw["raw/*.json<br/>Source snapshots"]
    Fetch --> Adapters["Validate and normalize<br/>Qualification / performance adapters"]
    Adapters --> Output["output.json<br/>Builds, measurements, systems, source status"]
    Config --> Output
    Raw --> Artifact["Actions dataset artifact"]
    Output --> Artifact
    Collector --> Logs["Actions logs and summary"]
    Artifact -. "next stage" .-> App["Static dashboard<br/>React + ECharts"]
```

Pending feeds contribute an awaiting-data status without a fetch. Failed feeds
contribute an error status and no normalized records; the artifact is diagnostic.
The dashboard and publishing are the next stage.

## Record relationships

```mermaid
flowchart TD
    Engine["Engine<br/>id"] -->|engine| Build["Qualification build<br/>source_id + build_id"]
    Engine -->|engine| Measurement["Performance measurement<br/>Model, workload, backend, version, time"]
    Source["Source<br/>id, commit, snapshot, hash"] -->|source_id| Build
    Source -->|source_id| Measurement
    Source -->|source_id| System["System<br/>source_id + id"]
    Measurement -->|"source_id + system_id (when supplied)"| System
    Build -->|source_pointer| Snapshot["Raw snapshot record"]
    Measurement -->|source_pointer| Snapshot
    System -->|source_pointer| Snapshot
    Build -->|report_url| Report["Pinned producer report<br/>Checks and evidence"]
```

Builds and measurements share an engine, but have no confirmed artifact-level
join. Performance build attribution and ROCm version remain null. Historical
measurements can also lack system metadata.
