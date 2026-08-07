"use client";

import { SignupSchema } from "@/lib/client-schemas";

/**
 * Client entry for the "use client" schema module. The server component only
 * imports this component — importing SignupSchema itself from the server would
 * hand back a client reference, whose safeParse is not a function.
 */
export function SignupStatus() {
  const valid = SignupSchema.safeParse({
    handle: "alice",
    email: "alice@example.com",
    acceptedTerms: true,
  });
  const invalid = SignupSchema.safeParse({ handle: "a", email: "nope", acceptedTerms: true });

  return <pre>{JSON.stringify({ valid: valid.success, invalid: invalid.success }, null, 2)}</pre>;
}
