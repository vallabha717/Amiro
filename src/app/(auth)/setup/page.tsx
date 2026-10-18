import SetupOwner from "@/components/auth/setup-owner";

// First-run owner setup. The (auth) layout's RedirectIfAuthed gate shows this
// only while /api/auth/status reports needsSetup.
export default function SetupPage() {
  return <SetupOwner />;
}
