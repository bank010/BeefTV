# Midjourney fixed four-image requests

The owner requested publishing Tencent VOD Midjourney and real BeefTV acceptance.
The BeefAPI model is `midjourney-v8.2`: each request generates and bills four
images. The generic image flow previously sent `n=1` and created separate tasks
for each requested canvas image, so selecting four images did not satisfy this
provider contract.

## Contract

`backend/internal/providerpreset/image_contracts.json` is shared by Go and the
frontend. The MJ entry declares `fixedOutputs=4`, native 1024 square requests,
automatic quality, a 2000-character prompt, one reference image up to 10 MiB and
no mask. Non-square output uses `--ar` in the prompt. Unsupported dimensions,
quality, transparency, references and counts are rejected before submission.

The settings show a fixed four-image count. Canvas generation creates four
candidate placeholders and submits one task with `count=4`; OpenAI Images JSON
or multipart sends `n=4`. All candidates retain the same task/operation identity
and their individual `taskOutputIndex` (0–3). Each output is saved and bound to
its own node. Submission freezes `metadata.outputNodeIds`; the backend permits
each output only at its declared destination and retains the existing ownership
and ready-resource checks. Binding writes are serialized; failure to bind one candidate does
not discard the other candidates or create another paid task.

Polling, result retrieval and reload use that output index. A new generation
clears the previous index. Submission-unknown state is propagated to the batch
root and every candidate; it blocks another generation and directs the user to
query the original task. Canceling the wait preserves all candidate identities; history
inserts all four indexed images and retry delegates the fixed batch only once.
A missing logical output fails immediately instead of polling or aliasing another
image. Known output-application errors retain the existing
continue-retrieval behavior.

Other image models keep their existing count and submission behavior. No schema
migration, credential handling, dependency or model price is changed.
The Create page likewise submits one four-output task and consumes the complete
task once, preserving all four conversation attachments.

## Verification

Build official protocol packages before Go tests, as CI does:

```sh
sh plugin-packages/build-packages.sh
cd backend && go test ./internal/generation ./internal/modelcatalog ./internal/providerpreset
cd ../web && bun test test/midjourney-generation.test.ts test/model-capabilities.test.ts test/canvas-image-save-barrier.test.ts test/canvas-task-bind-cutover.test.ts
bun run typecheck
```

The wire tests cover one `n=4` create for JSON and reference-image multipart,
all four returned results, the full execution path and rejection before create.
The frontend fixture uses the real canvas executor with a synthetic submission
boundary to verify one task, four distinct indices, serialized bindings, partial
binding failure, cancellation before/after acceptance and unknown submission with
no new task. History recovery and insertion check all four indices, and a sparse
output fails without querying or binding the wrong image. Neighboring save/bind
regressions run alongside it.

These deterministic tests do not prove a production generation or native app
readiness. Real acceptance still needs the installed BeefTV app, model discovery,
four saved and visible MJ candidates, a saved/playable Wan video and gateway
wallet reconciliation. Public desktop release is separate from a local candidate.
