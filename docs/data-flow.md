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
        Sources["llama.cpp<br/>vLLM<br/>Model performance"]
    end
    Fetch -->|Request| Sources
    Sources -->|JSON response| Fetch
    Fetch --> Map["Map fields<br/>Associate stable packages"]
    Map --> Output["Version index<br/>Builds + model performance"]
    Fetch --> Copies["Save source copies"]
    Output --> Artifact["Dataset artifact"]
    Copies --> Artifact
    Map --> Sync["Sync status + errors"]
    Sync --> Artifact
```

Fetch JSON requests each source file and receives its JSON response.
Each entry in the source list specifies a repository, branch, file, and mapping.
The job groups builds by ROCm version, writes compact summaries and monthly
history chunks, and uploads them with the source copies. Each run carries forward
build and assigned performance history from the previous successful main-branch dataset.
Stable package associations use saved evidence and authenticated benchmark job logs.
Manual and pull request runs follow the same steps.

## 2. Page load

When someone opens the dashboard, the browser reads the version index and the
overview for the selected ROCm version. It can read `sync.json` alongside the index
to show the latest sync result and affected-source errors.

```mermaid
flowchart LR
    Open["Open dashboard"] --> Index["Load version index"]
    Index --> Load["Load selected version"]
    Load --> Display["Populate views"]
    Display -->|Model history| Performance["Load model measurements"]
    Display -->|Browse builds| History["Load history chunk"]
    History -->|Open build| Report["Load build report"]
```

Selecting or comparing another ROCm version loads its overview. Build history
and reports load when requested. The browser processes the downloaded JSON locally.

The collector produces the versioned dataset. Site publishing and browser views
are the next implementation stage.

See [adding or changing a source](data-pipeline.md#adding-or-changing-a-source)
for an example and the pull request workflow.
