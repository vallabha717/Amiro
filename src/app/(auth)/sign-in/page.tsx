import SignIn from "@/components/auth/sign-in";

// getAuthConfig()/getIsFirstUser() dropped: internal/auth (Phase 2) is
// always email/password, always sign-up-enabled, no OAuth config to read.
export default function SignInPage() {
  return <SignIn />;
}
