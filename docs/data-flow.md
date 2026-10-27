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
    Fetch --> Map["Validate and map fields"]
    Map --> Output["Combined dataset<br/>output.json"]
```

Fetch JSON requests each source file and receives its JSON response.
Each entry in the source list specifies a repository, branch, file, and mapping.
The job uploads the dataset and original JSON files as a downloadable artifact.
Manual and pull request runs follow the same steps.

## 2. Page load

When someone opens the dashboard, the browser reads the version index and the
overview for the selected ROCm version.

```mermaid
flowchart LR
    Open["Open dashboard"] --> Index["Load version index"]
    Index --> Load["Load selected version"]
    Load --> Display["Populate views"]
```

Each version's overview will group engine and model summaries. Selecting or
comparing another version loads its overview; build details load when opened.
The browser downloads the needed JSON from the site and processes it locally.

Version-specific files, site publishing, and page loading are planned. The current
collector writes one combined `output.json`.

See [adding or changing a source](data-pipeline.md#adding-or-changing-a-source)
for an example and the pull request workflow.
