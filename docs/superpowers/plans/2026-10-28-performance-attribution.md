# Complete performance attribution

Goal: regenerate a clean dataset with verified ROCm associations for every ROCm performance observation, and an explicit comparison category for other backends.

Approved approach: extend the existing package-evidence pipeline, retain model/workload/hardware identities, fail collection on unresolved ROCm identity, and regenerate without previous data. Never infer a version from dates or build number alone. Qualification links require the exact artifact identity.

- [x] Inspect producer packages and historical job evidence for every ROCm fork.
- [x] Add failing attribution tests for nonstable packages, ambiguous evidence and unavailable evidence; implement exact evidence resolution.
- [x] Replace unassigned output with comparisons; reject unresolved ROCm rows, preserve legacy restoration.
- [x] Add an explicit clean rebuild option to CI while preserving publication concurrency checks.
- [x] Run full unittest suite, Black, fresh ingestion, manifest validation and evidence audit.
- [x] Review the branch, prepare the next PR, and report real counts and any remaining evidence blockers.

Validation: fresh source ingestion completed with 564 ROCm measurements and 301
comparison records; no unassigned output. All 107 available qualification build
records retained. 28 model observations carry producer-declared cached registry
evidence. A second collection reused verified historical evidence with external
job resolution disabled. Publication manifest validation passed. Remaining
producer limitations: nightly qualification, Whisper and Stable Diffusion feeds
await data; vLLM qualification is stale.
