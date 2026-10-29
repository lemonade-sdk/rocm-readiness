# UI design reference

The shell follows the refined local `output/lemonade-readiness.html` prototype
referenced by milestone INDEX #20, titled **Lemonade Performance**. This note
captures the applicable layout without importing the prototype's bundled
historical dataset, scripts or deferred-engine panels.

```text
Lemonade Performance                         stable llama.cpp | ROCm selector
Breadcrumb                                   selected version
Latest ingestion status                      refresh

Selected ROCm heading                        release label
Overview | Engine builds | Model performance

Retained builds       Available platforms       Historical measurements

Engine readiness
  llama.cpp                                   explore builds
  Linux latest package                        Windows latest package
  qualification / outcome / hardware evidence  qualification / outcome / hardware evidence

Dataset revision and timestamp                pinned index / source repository
```

Preserved visual choices: warm charcoal background, layered olive-gray panels,
muted secondary labels, lemon-yellow navigation accents, soft borders, rounded
cards, and green/amber status accents with text labels. Platform cards sit side
by side on wide screens and stack on narrow screens. Semantic links, native
selects and visible focus rings support keyboard access.

Readiness counts come from the selected version's JSON. Qualification, test
outcome and hardware validation remain separate. Performance stays within the
engine context; historical observations retain their date and package scope.
