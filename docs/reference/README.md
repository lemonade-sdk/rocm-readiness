# Published JSON reference

The collector resolves each configured producer branch to a commit before reading
it. The publisher writes the successful dataset under `main/data/`, then writes
its [live pointer](latest.md). Consumers follow that pointer and resolve every
relative dataset path against the pinned `index_url`.

| File | Reference |
| --- | --- |
| Repository `sources.json` | [Source configuration](sources.md) |
| `data/latest.json` | [Live pointer](latest.md) |
| `data/index.json` | [Dataset catalog and source states](index.md) |
| `data/sync.json` | [Attempt status](sync.md) |
| `data/rocm/<version>/overview.json` | [ROCm overview](overview.md) |
| `data/rocm/<version>/history/YYYY-MM.json` | [Build history and build records](history.md) |
| `data/rocm/<version>/performance.json` | [Measurements and hardware](performance.md) |
| `data/rocm/<version>/executions.json` | [Benchmark execution outcomes](executions.md) |
| Producer-to-output transformations | [Field lineage and pinned examples](mappings.md) |

The references describe the current stable llama.cpp contract. A field marked
**required** is emitted in newly generated files; **nullable** means JSON `null`
is a valid value. **Optional** means a property may be absent. Optional legacy
fields are called out separately. JSON pointers use `/`-separated property names;
`*` in mapping tables means each array element or object member, not a literal
JSON-pointer token. Escape `/` and `~` in producer keys as `~1` and `~0`.

Dataset paths are relative to `data/`, use `/`, and cannot contain absolute paths,
`..`, symlinks, or non-JSON files. Producer evidence URLs are absolute and pinned
where the producer uses Git commits. Benchmark run and job URLs identify the
measurement and package evidence, rather than the qualification build.

`schema_version` identifies each file's layout. `attribution_version: 2` in the
catalog identifies the verified package-association contract. There is no
requirement that unrelated file types have the same schema version.

## Validation

The [test-and-ingestion command](../../README.md#run-locally) runs pipeline tests
before collection. Tests include independently specified producer mappings,
derived-value corruption cases, and publication recovery. Collection validates
source records and package evidence, then runs
`scripts/conformance.py::validate_dataset()` against the completed successful
dataset before returning success. Publication checks the linked manifest,
retained records, and sync consistency before changing the live pointer.

The collection gate checks generated dataset files and sync metadata. It leaves
an existing `latest.json` to the publisher, which updates the pointer after the
dataset commit exists. Standalone validation also checks the live pointer when
present.

To check an existing local snapshot without fetching producer data:

```sh
uv run --no-project --python 3.12 python scripts/conformance.py --data-dir data --sources sources.json
```

Omit `--sources` to check a retained snapshot independently of today's source
configuration. Supply it when checking that current source/fork filters match
the generated records.

A source error identifies `source_id`, `record`, `field`, and `reason` as described
in [sync status](sync.md). The [mapping reference](mappings.md) supplies the source
revision and transformation needed to investigate a field discrepancy.
