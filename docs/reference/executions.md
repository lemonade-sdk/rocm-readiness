# Benchmark execution data

When `execution_details` is enabled on the stable benchmark source, collection
reads every matching `results/<fork>/<model>/run-*.json` file from the pinned
producer tree. An incomplete tree or failed fetch fails collection. Immutable
blob caches avoid downloading unchanged files again.

`data/rocm/<version>/executions.json` has schema version **1**, the matching
`rocm_version`, normalized `attempts`, and compact `summaries`. The overview links
to this file through optional `execution.path`, with `attempt_count` and the same
summaries. Older overviews can omit `execution`.

Each attempt retains model/checkpoints, configured scenario/context/backend
arguments, actual physical hardware, timestamp, engine package and verified ROCm
identity. Source URL, JSON pointer, blob/checksum and benchmark run identify the
original evidence. Package/job provenance identifies the attempted engine binary;
the hardware report's installed-backend inventory does not establish that identity.
Quantization is nullable when not explicitly supplied.

Execution statuses describe benchmark completion:

| Status | Producer evidence |
| --- | --- |
| `failed` | Explicit `all_runs_failed: true`. |
| `passed` | Explicit zero `failed_runs`, positive configured measurement count, no all-failed flag, and the producer’s successful-output shape. |
| `partial` | Explicit positive `failed_runs`, positive configured measurement count, no all-failed flag, and the producer’s successful-output shape. |
| `unknown` | Execution fields do not establish one of the above. |

The successful-output shape includes finite nonnegative means for throughput,
duration and time to first token. These corroborate explicit execution fields;
metrics alone cannot establish a pass.

Failures can include warmups. Subtracting failures from configured measurement
runs does not yield a valid successful-run count. Execution status does not
establish answer accuracy or build qualification.

Package attribution precedes latest selection within each ROCm version. Latest
selection separates source/fork, model/checkpoints/quantization, configured
workload and physical system. It excludes build tag and achieved input/output
tokens: a newer failed attempt replaces an older success. Conflicting timestamp
ties fail collection.

Summaries separate engine package, ROCm, hardware/OS and configured workload.
`total` counts unique model IDs; multiple observed variants count once and must
all pass for that model to be counted in `passed`. Any failed variant makes the
model failed; otherwise a partial variant makes it partial. A scope containing
unknown execution evidence has no summary. Each summary carries its hardware,
package, model IDs and latest report date; it does not imply testing of the newest
qualified build.

The collection artifact retains the full source inventory and raw documents in
`provenance/executions.json`. These raw bodies are not published to the UI dataset.
Collection requires independent conformance checks against that evidence: they
validate outcome/identity mappings, reconstruct latest selection against verified
package evidence, and reject missing failed attempts. Standalone validation of a
published snapshot checks the projected contracts, package proof and summary counts. Source and attribution errors retain
the existing failed-publication and last-good-data behavior.
