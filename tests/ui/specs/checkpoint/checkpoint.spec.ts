import { ChatPage } from "../../pages";
import { expect, test } from "../../support/fixtures";

// The composer's ProseMirror editor is not guaranteed ready the instant
// domcontentloaded fires (the signedIn fixture's own wait) -- waiting for
// it to be visible here, rather than in the shared ChatPage.sendMessage
// helper every other spec already depends on, keeps this fix scoped to
// this spec's own file rather than changing behavior other specs rely on.
async function waitForComposerReady(chat: ChatPage) {
  await expect(chat.input.first()).toBeVisible({ timeout: 15000 });
}

// The fake provider's tool-call scripting (fixtures.ts's
// fakeToolCallName/fakeToolCallArgs -- see fakeprovider_cmd.go) is what
// makes this spec possible at all: without it, a UI spec has no way to
// make the "model" actually call write_file, and the "Rewind to here"
// action (docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's
// deliverable 3) only ever appears on a message with a real file-writing
// tool call in it.
test.describe("checkpoint rewind", () => {
  test.use({
    fakeToolCallName: "write_file",
    fakeToolCallArgs: JSON.stringify({
      path: "note.txt",
      content: "hello from the fake provider",
    }),
  });

  test("shows the rewind action on a message with a file write, lists the file, and reverts on confirm", async ({
    amiro,
    signedIn,
  }) => {
    const chat = new ChatPage(signedIn);
    await waitForComposerReady(chat);
    await chat.sendMessage("please write a note");
    await chat.waitForStreamingComplete();

    // The default permission mode (interactive) pauses a write_file call
    // for approval -- the turn has not actually written anything, and
    // there is nothing to checkpoint, until this is answered.
    const approve = signedIn.getByRole("button", {
      name: "Approve",
      exact: true,
    });
    await expect(approve).toBeVisible({ timeout: 15000 });
    await approve.click();
    await chat.waitForStreamingComplete();

    const rewindButton = signedIn
      .locator('[data-testid="rewind-to-here-button"]')
      .last();
    await expect(rewindButton).toBeVisible({ timeout: 15000 });
    await rewindButton.click();

    const dialog = signedIn.locator('[data-testid="rewind-confirm-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(
      signedIn.locator('[data-testid="rewind-confirm-file-list"]'),
    ).toContainText("note.txt", { timeout: 15000 });

    await signedIn.locator('[data-testid="rewind-confirm"]').click();
    await expect(dialog).toBeHidden({ timeout: 15000 });

    // The restore is a real API call -- confirm the checkpoint index (the
    // same fact the dialog itself was built from) reflects it: the file
    // never existed before this turn, so it should have been deleted, not
    // left behind.
    const threadId = new URL(signedIn.url()).searchParams.get("thread");
    expect(threadId).toBeTruthy();
    const messageId = await signedIn
      .locator('[data-message-role="assistant"]')
      .last()
      .getAttribute("data-message-id");
    expect(messageId).toBeTruthy();

    const filesRes = await signedIn.request.get(
      `${amiro.baseUrl}/api/checkpoint/files?threadId=${threadId}&turnId=${messageId}`,
      { headers: { Authorization: `Bearer ${amiro.accounts.user.token}` } },
    );
    expect(filesRes.ok()).toBeTruthy();
    const files = await filesRes.json();
    expect(files.files).toEqual([
      expect.objectContaining({ path: "note.txt", existedBefore: false }),
    ]);
  });
});

test.describe("checkpoint rewind, plain text turn", () => {
  test("does not show the rewind action when the turn wrote nothing", async ({
    signedIn,
  }) => {
    const chat = new ChatPage(signedIn);
    await waitForComposerReady(chat);
    await chat.sendMessage("just say hi");
    await chat.waitForStreamingComplete();

    await expect(
      signedIn.locator('[data-testid="rewind-to-here-button"]'),
    ).toHaveCount(0);
  });
});
