#!/usr/bin/env tsx
/**
 * LIVE E2E: the publish → resolve → delete cycle a dataset deletion depends on,
 * against the REAL Modal API.
 *
 * WHY IT EXISTS. Modal images used to be unreclaimable: the platform recorded
 * `store_unsupported` and they accumulated. The verb to delete one is real but
 * UNDOCUMENTED (modal@0.9.0 `client.images.delete`; Modal's images guide and
 * modal.Image reference both omit it), so every claim this reclaim rests on is a
 * claim about someone else's unpublished behaviour. Unit tests can only assert
 * what our own code does with a mock. This asserts what Modal actually does.
 *
 * LIVE, and it builds a real image — run it deliberately, not in CI:
 *   MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... npx tsx tests/integration/e2e-image-publish-reclaim.ts
 *
 * Last run 2026-08-20: all seven checks passed. It also settled two things that
 * had been assumed: re-publishing a name is NOT an error (so the preparation
 * queue may re-run safely), and deleting an image does NOT remove its published
 * NAME — fromName keeps resolving to the dead id, and Modal ships no verb to
 * unpublish. That residue is recorded in the platform's reclaim runner.
 */
import { createHash } from "node:crypto";
import { ModalClient, NotFoundError } from "modal";

const IMAGE = "python:3.11-slim";
const APP = "evolve-modal-probe";

let failures = 0;
function expect(condition: boolean, message: string): void {
  console.log(`   ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

async function main(): Promise<void> {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    console.error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for this live run");
    process.exit(2);
  }
  // Unique per run so a previous run's leftovers cannot make this one pass.
  const alias = `evolve-eval-${createHash("sha256")
    .update(`e2e:${process.pid}:${IMAGE}`)
    .digest("hex")
    .slice(0, 32)}`;
  const client = new ModalClient({ timeoutMs: 300_000 });
  const app = await client.apps.fromName(APP, { createIfMissing: true });

  console.log(`[1] build ${IMAGE} and bind our name ${alias}`);
  const built = await client.images.fromRegistry(IMAGE).build(app);
  expect(built.imageId !== "", "a built image carries an id — the thing delete takes");
  await built.publish(alias);

  console.log("\n[2] the name resolves back to that id, with no rebuild");
  const found = await client.images.fromName(alias);
  expect(found.imageId === built.imageId, "fromName returns the id we published");

  console.log("\n[3] re-publishing the same name is not an error");
  // The preparation queue can re-run for the same dataset; if this threw, every
  // re-preparation would fail.
  let republished = true;
  try {
    await built.publish(alias);
  } catch {
    republished = false;
  }
  expect(republished, "the queue may publish the same name twice");

  console.log("\n[4] delete the image");
  await client.images.delete(found.imageId);

  console.log("\n[5] it is REALLY gone — not a soft flag");
  const byId = await client.images
    .fromId(found.imageId)
    .then(() => "still-resolves")
    .catch((e: unknown) => (e as Error).name);
  expect(byId === "NotFoundError", "fromId answers NotFound after the delete");

  let booted = "refused";
  try {
    const image = await client.images.fromId(found.imageId);
    const sandbox = await client.sandboxes.create(app, { image, command: ["sleep", "5"] });
    booted = sandbox.sandboxId;
    await sandbox.terminate();
  } catch {
    // expected
  }
  expect(booted === "refused", "a sandbox cannot boot from the deleted image");

  const rebuilt = await client.images.fromRegistry(IMAGE).build(app);
  expect(rebuilt.imageId !== found.imageId, "rebuilding the same content mints a NEW id");

  console.log("\n[6] the NAME survives the image — recorded, not assumed");
  // Modal ships no unpublish verb. This is the one residue of the reclaim, and
  // the platform's runner documents it rather than pretending it is clean.
  const nameAfter = await client.images
    .fromName(alias)
    .then((i) => i.imageId)
    .catch((e: unknown) => (e as Error).name);
  expect(
    nameAfter === found.imageId,
    "fromName still resolves to the dead id — the known, bounded residue",
  );

  console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("unexpected:", e);
  process.exit(1);
});
