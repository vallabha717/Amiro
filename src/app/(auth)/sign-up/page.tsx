import EmailSignUp from "@/components/auth/email-sign-up";

// Renders the email sign-up flow directly -- the old provider-picker page
// (components/auth/sign-up.tsx, deleted) only existed to choose between
// email and social sign-up, and social sign-up isn't carried over (see
// auth/client.ts's doc comment).
export default function SignUp() {
  return <EmailSignUp />;
}
