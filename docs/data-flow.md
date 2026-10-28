# Data flow

## Data sources

| Data | Repository branch | JSON file |
| --- | --- | --- |
| llama.cpp | [llama.cpp / qualification-data](https://github.com/lemonade-sdk/llama.cpp/tree/qualification-data) | [qualification/index.json](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/index.json) |
| vLLM | [vllm-rocm / qualification-data](https://github.com/lemonade-sdk/vllm-rocm/tree/qualification-data) | [qualification/index.json](https://github.com/lemonade-sdk/vllm-rocm/blob/qualification-data/qualification/index.json) |
| Model performance | [lemonade / benchmark-data](https://github.com/lemonade-sdk/lemonade/tree/benchmark-data) | [leaderboard.json](https://github.com/lemonade-sdk/lemonade/blob/benchmark-data/leaderboard.json) |

## 1. Scheduled ingestion

The daily job reads the source list, fetches the latest data, and combines it.

```mermaid
flowchart LR
    Config["Source list<br/>sources.json"] --> Fetch["Fetch JSON"]
    subgraph Data["Data"]
        LlamaCpp["llama.cpp"]
        Vllm["vLLM"]
        Performance["Model performance"]
    end
    Fetch <-->|Request| Data
    Fetch --> Map["Mapping"]
    Map --> Output["Indexing"]
    Map --> Copies["Save source copies"]
    Output --> Publish["Stage final JSON"]
    Publish --> Main["Squash into main"]
    Main --> Latest["latest.json<br/>Pinned dataset + sync"]
    Copies --> Artifact["CI evidence<br/>30D retention"]
    Map --> Sync["Sync status"]
    Sync --> Artifact
    Sync --> Latest
```

Fetch JSON requests each source file and receives its JSON response.
Each entry in the source list specifies a repository, branch, file, and mapping.
The job groups builds by ROCm version, writes compact summaries and monthly
history chunks. Trusted runs stage final JSON on a temporary working branch,
squash those changes into `main`, and update the latest pointer in the same push.
Each run restores build and model history from `main/data/`.
Stable package associations use saved evidence and authenticated benchmark job logs.
PR runs validate and upload temporary artifacts. Raw copies and logs remain in
those artifacts. Failed main runs update only the latest sync status.

## 2. Page load

When someone opens the dashboard, the browser reads the version index and the
overview for the selected ROCm version. `latest.json` supplies the current sync
status and pins the index and data files to one immutable commit.

```mermaid
flowchart LR
    Open["Open dashboard"] --> Pointer["Read latest.json"]
    Pointer --> Index["Load pinned version index"]
    Index --> Load["Load selected version"]
    Load --> Display["Populate views"]
    Display -->|Model history| Performance["Load model measurements"]
    Display -->|Browse builds| History["Load history chunk"]
    History -->|Open build| Report["Load build report"]
```

Selecting or comparing another ROCm version loads its overview. Build history
and reports load when requested. The browser processes the downloaded JSON locally.

The workflow publishes the versioned JSON. Browser views are the next stage.

See [adding or changing a source](data-pipeline.md#adding-or-changing-a-source)
for an example and the pull request workflow.
