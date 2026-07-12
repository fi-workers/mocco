import { z } from 'zod';

// Client-side auth form validation. (The vendor enforces the real rules
// server-side; these give immediate feedback and shape the form values.)
export const signInSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
});

export const signUpSchema = signInSchema.extend({
  name: z.string().min(1, 'Name is required'),
});

export type SignUpValues = z.infer<typeof signUpSchema>;
