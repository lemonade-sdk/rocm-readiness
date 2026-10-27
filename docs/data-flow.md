# Data flow

Data moves at two different times: Actions refreshes the dataset on a schedule,
and the browser reads that dataset when someone opens the dashboard.

```mermaid
flowchart TB
    subgraph Ingestion["1. Scheduled ingestion — GitHub Actions"]
        Start["Daily run starts"] --> Config["Read sources.json"]
        Config --> Fetch["For each source:<br/>fetch JSON from its configured branch"]
        Fetch --> Map["Validate and map fields"]
        Map --> Output["Write combined output.json"]
        Output --> Artifact["Upload dataset artifact"]
    end

    subgraph Repositories["Source repositories"]
        Llama["lemonade-sdk/llama.cpp<br/>qualification-data branch"]
        Vllm["lemonade-sdk/vllm-rocm<br/>qualification-data branch"]
        Bench["lemonade-sdk/lemonade<br/>benchmark-data branch"]
    end
    Llama --> Fetch
    Vllm --> Fetch
    Bench --> Fetch

    Artifact -. "Publish dataset with the site (planned)" .-> Hosted["Hosted output.json"]

    subgraph Runtime["2. Page load — browser (planned)"]
        Open["User opens dashboard"] --> Load["Fetch hosted output.json"]
        Load --> Display["Populate dashboard views"]
    end
    Hosted --> Load
```

Each ingestion run reads the latest revision of each configured branch and records
which revision supplied the data. Original JSON copies accompany the combined
dataset so results can be traced back to their sources. Manual and pull request
runs use the same ingestion steps.

Ingestion currently produces a downloadable Actions artifact. Site publishing and
browser loading are the next implementation stage. Once connected, page loads
use the published dataset; scheduled ingestion refreshes it independently.

See [adding or changing a source](data-pipeline.md#adding-or-changing-a-source)
for a configuration example and the pull request workflow.
