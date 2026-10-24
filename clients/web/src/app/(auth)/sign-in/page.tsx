import SignIn from "@/components/auth/sign-in";

// Amiro's auth is always email/password with no OAuth config to read. A fresh
// instance with no account is shown the first-run setup page instead.
export default function SignInPage() {
  return <SignIn />;
}
