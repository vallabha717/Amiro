import { describe, expect, it } from "vitest";
import { ManualToolConfirmTag } from "./chat";

/**
 * The Go backend's approvals.go recognizes an approval answer purely by
 * decoding a tool part's `output` into `{ Tag string `json:"__tag"` }` and
 * comparing it to "manual-tool-confirm" (parseApprovalAnswer). This test
 * pins that exact wire shape from the frontend side of the same contract --
 * it is what the Amiro TUI's session.BuildApprovalResubmission (Go) also
 * produces, so the two surfaces answering an approval must produce
 * byte-compatible JSON.
 *
 * It exists because that byte-compatibility broke silently once already:
 * ManualToolConfirmTag used to be built with lib/tag.ts's generic tag()
 * helper, whose wire key is `__$ref__`, not `__tag`. Every "Approve" click
 * in the desktop app sent `{__$ref__:"manual-tool-confirm", confirm, scope}`,
 * which parseApprovalAnswer's `Tag != "manual-tool-confirm"` check silently
 * rejected -- the confirmation object round-tripped back to the model as if
 * it were the tool's own result, and the approval was simply never applied.
 * Nothing failed loudly; the desktop app's own tool-presenters/types.ts
 * checked for `__tag` in a different code path (rendering, not sending),
 * which is what makes this the kind of bug a type system doesn't catch:
 * both sides used the string "manual-tool-confirm", just keyed differently.
 */
describe("ManualToolConfirmTag", () => {
  it("creates the exact shape approvals.go's parseApprovalAnswer requires", () => {
    const out = ManualToolConfirmTag.create({ confirm: true, scope: "always" });
    expect(out).toEqual({
      __tag: "manual-tool-confirm",
      confirm: true,
      scope: "always",
    });
  });

  it("omits scope when the caller doesn't pass one, matching Go's omitempty", () => {
    const out = ManualToolConfirmTag.create({ confirm: false });
    expect(out).toEqual({ __tag: "manual-tool-confirm", confirm: false });
    expect("scope" in out).toBe(false);
  });

  it("round-trips through JSON with the __tag key intact", () => {
    const wire = JSON.parse(JSON.stringify(ManualToolConfirmTag.create({ confirm: true, scope: "once" })));
    expect(wire.__tag).toBe("manual-tool-confirm");
  });
});
